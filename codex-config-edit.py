"""Narrow, lossless TOML edits for the local AUTO helper (Python 3.11+).

No TOML serializer dependency: retain source text and verify the complete parsed
result equals the original with only explicitly selected keys changed.
"""
import base64
import copy
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import tomllib
import uuid
from urllib.parse import urlsplit


class RepairError(Exception):
    pass


def parse(text):
    try:
        return tomllib.loads(text.lstrip('\ufeff'))
    except (tomllib.TOMLDecodeError, ValueError):
        raise RepairError('Invalid TOML; repair refused without changing the file.') from None


def statements(text):
    """Yield complete TOML statement spans; strings/comments are never keys."""
    start = i = depth = 0
    quote = None
    multiline = False
    while i < len(text):
        c = text[i]
        if quote:
            if quote == '"' and c == '\\':
                i += 2
                continue
            if c == quote:
                run = 1
                while i + run < len(text) and text[i + run] == quote:
                    run += 1
                if not multiline or run >= 3:
                    quote = None
                    multiline = False
                    i += run if run >= 3 else 1
                    continue
            i += 1
            continue
        if c in ('"', "'"):
            quote = c
            multiline = text[i:i + 3] == c * 3
            i += 3 if multiline else 1
            continue
        if c == '#':
            end = text.find('\n', i)
            i = len(text) if end == -1 else end
            continue
        if c in '[{':
            depth += 1
        elif c in ']}':
            depth -= 1
        elif c == '\n' and depth == 0:
            yield start, i + 1, text[start:i + 1]
            start = i + 1
        i += 1
    if start < len(text):
        yield start, len(text), text[start:]


def leaf_path(value):
    path = []
    while isinstance(value, dict) and len(value) == 1:
        key, value = next(iter(value.items()))
        path.append(key)
    if value != 0 or not path:
        raise RepairError('Unsupported targeted TOML syntax; no file changed.')
    return tuple(path)


def key_assignment(statement):
    quote = None
    escaped = False
    for i, c in enumerate(statement):
        if quote:
            if escaped:
                escaped = False
            elif quote == '"' and c == '\\':
                escaped = True
            elif c == quote:
                quote = None
        elif c in ('"', "'"):
            quote = c
        elif c == '=':
            key = statement[:i].strip().lstrip('\ufeff')
            return leaf_path(parse(key + ' = 0')), i
    return None


def patch_toml(text, selected, edits):
    original = parse(text)
    expected = copy.deepcopy(original)
    scope = expected
    for key in selected:
        scope = scope[key]
    scope.update(edits)
    table = ()
    matches = {}
    insertion = 0 if not selected else None
    for start, end, source in statements(text):
        stripped = source.strip().lstrip('\ufeff')
        if not stripped or stripped.startswith('#'):
            continue
        if stripped.startswith('['):
            # Parse a synthetic value under the header. Array tables cannot be
            # selected by this helper, but their bodies must never be root keys.
            if stripped.startswith('[['):
                table = ('<array-table-not-selected>',)
            else:
                table = leaf_path(parse(stripped + '\n__auto_repair_marker__ = 0'))[:-1]
            if table == selected:
                insertion = end
            continue
        found = key_assignment(source)
        if not found:
            continue
        keys, equal = found
        full = table + keys
        if full[:-1] == selected and full[-1] in edits:
            if full[-1] in matches:
                raise RepairError('Duplicate target key; no file changed.')
            # Replace the entire value statement, retaining the exact key spelling.
            # Comments on edited values may be replaced; all other text is untouched.
            newline = '\r\n' if source.endswith('\r\n') else '\n' if source.endswith('\n') else ''
            value = edits[full[-1]]
            matches[full[-1]] = (start, end, source[:equal + 1] + ' ' + json.dumps(value, ensure_ascii=False) + newline)
    missing = {key: value for key, value in edits.items() if key not in matches}
    if missing and insertion is None:
        raise RepairError('Selected profile uses unsupported inline/dotted table syntax; no file changed.')
    replacements = list(matches.values())
    if missing:
        newline = '\r\n' if '\r\n' in text else '\n'
        added = ''.join(key + ' = ' + json.dumps(value, ensure_ascii=False) + newline for key, value in missing.items())
        # Preserve a UTF-8 BOM at byte zero when inserting root keys.
        offset = insertion
        if offset == 0 and text.startswith('\ufeff'):
            offset = 1
        if offset and text[offset - 1] not in '\n\ufeff':
            added = newline + added
        replacements.append((offset, offset, added))
    candidate = text
    for start, end, value in sorted(replacements, reverse=True):
        candidate = candidate[:start] + value + candidate[end:]
    if parse(candidate) != expected:
        raise RepairError('Lossless TOML verification failed; no file changed.')
    return candidate


def merged(base, overlay):
    result = copy.deepcopy(base)
    for key, value in overlay.items():
        result[key] = merged(result[key], value) if isinstance(value, dict) and isinstance(result.get(key), dict) else copy.deepcopy(value)
    return result


def local_url(value):
    try:
        url = urlsplit(value)
        if (url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost', '::1')
                or url.username or url.password or url.query or url.fragment
                or url.path.rstrip('/') != '/v1' or not url.port):
            raise ValueError()
        return (url.hostname, url.port, '/v1')
    except (ValueError, TypeError):
        raise RepairError('Provider must use a credential-free HTTP loopback /v1 URL with an explicit port.') from None


def prepare(text, *, base_text='', legacy_profile=None, catalog=None, gateway='http://127.0.0.1:8090/v1', context=None):
    original = parse(text)
    base = parse(base_text)
    if legacy_profile:
        if not re.fullmatch(r'[A-Za-z0-9_-]+', legacy_profile):
            raise RepairError('Invalid legacy profile name.')
        scope = original.get('profiles', {}).get(legacy_profile)
        if not isinstance(scope, dict):
            raise RepairError('The explicitly selected legacy profile does not exist.')
        if original.get('profile') not in (None, legacy_profile):
            raise RepairError('Top-level legacy selector names a different profile; verify the launcher before repair.')
        effective = merged(merged(base, original), scope)
        selected = ('profiles', legacy_profile)
    else:
        if 'profile' in original or 'profile' in base:
            raise RepairError('Legacy profile selector found. Verify client version and pass --legacy-profile explicitly; no automatic migration.')
        effective = merged(base, original)
        selected = ()
    provider_id = effective.get('model_provider')
    if not isinstance(provider_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', provider_id):
        raise RepairError('Selected files do not identify an existing local model_provider.')
    provider = effective.get('model_providers', {}).get(provider_id)
    if not isinstance(provider, dict) or local_url(provider.get('base_url')) != local_url(gateway):
        raise RepairError('Selected provider does not match the explicitly expected local gateway URL.')
    if provider.get('requires_openai_auth') is not False or provider.get('wire_api', 'responses') != 'responses':
        raise RepairError('Selected provider must already be no-auth and use Responses; provider settings are never rewritten.')
    # Do not use, print, delete, or forward any credential/header configuration.
    auth_fields = ('env_key', 'env_key_instructions', 'experimental_bearer_token', 'http_headers', 'env_http_headers', 'credential_provider')
    if any(provider.get(key) not in (None, {}, '') for key in auth_fields):
        raise RepairError('Selected provider has authentication/header settings; review locally. Repair will not read or use credentials.')
    safe = {'provider': provider_id, 'gateway': gateway, 'selectedProfile': legacy_profile,
            'modelBefore': effective.get('model'), 'catalogBefore': effective.get('model_catalog_json')}
    if catalog is None:
        return safe
    edits = {'model': 'auto', 'model_catalog_json': catalog}
    # Explicit overrides can otherwise advertise more than AUTO's smallest route.
    window = effective.get('model_context_window', context)
    if not isinstance(window, int) or isinstance(window, bool) or window <= 0:
        raise RepairError('Invalid explicit context limit; no file changed.')
    window = min(window, context)
    for key, maximum in (('model_context_window', context), ('model_auto_compact_token_limit', max(1, int(window * .8)))):
        value = effective.get(key)
        if value is not None:
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                raise RepairError('Invalid explicit context limit; no file changed.')
            if value > maximum:
                edits[key] = maximum
    candidate = patch_toml(text, selected, edits)
    safe.update(edits=edits, candidate=base64.b64encode(candidate.encode('utf-8')).decode('ascii'))
    return safe


def secure_temp(path):
    if os.name != 'nt':
        return tempfile.mkstemp(prefix='.auto-repair-', suffix='.tmp', dir=path.parent)
    # Never write credentials into a file with an inherited, potentially broader
    # DACL. Supply the source DACL at CREATE_NEW, with inheritance protected.
    # If READ_CONTROL/security descriptor access fails, fail closed.
    import msvcrt
    from ctypes import wintypes
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    get_security = advapi.GetFileSecurityW
    get_security.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    get_security.restype = wintypes.BOOL
    needed = wintypes.DWORD()
    get_security(str(path), 4, None, 0, ctypes.byref(needed))
    if not needed.value:
        raise RepairError('Cannot read source Windows DACL; no temporary config created.')
    descriptor = ctypes.create_string_buffer(needed.value)
    if not get_security(str(path), 4, descriptor, needed, ctypes.byref(needed)):
        raise RepairError('Cannot read source Windows DACL; no temporary config created.')
    control = advapi.SetSecurityDescriptorControl
    control.argtypes = [ctypes.c_void_p, wintypes.WORD, wintypes.WORD]
    control.restype = wintypes.BOOL
    if not control(descriptor, 0x1000, 0x1000):  # SE_DACL_PROTECTED
        raise RepairError('Cannot protect temporary Windows DACL; no config bytes written.')

    class SecurityAttributes(ctypes.Structure):
        _fields_ = [('nLength', wintypes.DWORD), ('lpSecurityDescriptor', ctypes.c_void_p), ('bInheritHandle', wintypes.BOOL)]

    attributes = SecurityAttributes(ctypes.sizeof(SecurityAttributes), ctypes.cast(descriptor, ctypes.c_void_p), False)
    create = kernel.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(SecurityAttributes), wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    pending = str(path.parent / ('.auto-repair-' + str(uuid.uuid4()) + '.tmp'))
    handle = create(pending, 0x40000000, 0, ctypes.byref(attributes), 1, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        raise RepairError('Cannot create protected temporary Windows file; no config bytes written.')
    try:
        fd = msvcrt.open_osfhandle(handle, os.O_WRONLY | os.O_BINARY)
    except Exception:
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle(handle)
        os.unlink(pending)
        raise
    return fd, pending


def safe_replace(config, candidate, expected_hash, backup):
    path = Path(config)
    info = path.lstat()
    if os.name == 'nt' and getattr(info, 'st_file_attributes', 0) & 0x4000:
        raise RepairError('EFS-encrypted config is unsupported; no plaintext temporary file created.')
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or path.is_symlink():
        raise RepairError('Config must be a regular, non-linked file.')
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected_hash:
        raise RepairError('Config changed since inspection. Nothing overwritten; inspect again.')
    if Path(backup).exists():
        raise RepairError('Backup path already exists; nothing overwritten.')
    fd, pending = secure_temp(path)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(candidate)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(pending, stat.S_IMODE(info.st_mode))
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected_hash:
            raise RepairError('Config changed during preparation; nothing overwritten.')
        if os.name == 'nt':
            # ReplaceFileW atomically replaces contents, creates the backup, and
            # preserves/merges destination metadata including its Windows ACL.
            replace = ctypes.WinDLL('kernel32', use_last_error=True).ReplaceFileW
            replace.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_void_p]
            replace.restype = ctypes.c_int
            if not replace(str(path), pending, str(backup), 0, None, None):
                raise RepairError('Windows atomic replacement failed (error %d). Inspect config and backup before retrying.' % ctypes.get_last_error())
        else:
            with open(backup, 'xb') as out:
                os.chmod(backup, stat.S_IMODE(info.st_mode) & 0o600)
                out.write(path.read_bytes())
                out.flush()
                os.fsync(out.fileno())
            os.replace(pending, path)
    finally:
        if os.path.exists(pending):
            os.unlink(pending)


def main(request):
    if request.get('action') == 'replace':
        safe_replace(request['config'], base64.b64decode(request['candidate']), request['expectedHash'], request['backup'])
        return {'replaced': True}
    text = Path(request['config']).read_bytes().decode('utf-8')
    base = Path(request['baseConfig']).read_bytes().decode('utf-8') if request.get('baseConfig') else ''
    return prepare(text, base_text=base, legacy_profile=request.get('legacyProfile'), catalog=request.get('catalog'),
                   gateway=request.get('gateway', 'http://127.0.0.1:8090/v1'), context=request.get('context'))


if __name__ == '__main__':
    try:
        print(json.dumps(main(json.loads(sys.stdin.buffer.read().decode('utf-8')))))
    except Exception as exc:
        # Never echo raw config, provider credentials, or parser input.
        message = str(exc) if isinstance(exc, RepairError) else 'Local config operation failed (%s); no raw configuration printed.' % type(exc).__name__
        print(json.dumps({'error': message}))
        sys.exit(1)
