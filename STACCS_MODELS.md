# Complete staccs leCore inventory

Public Hugging Face metadata checked on 2026-10-21. Revisions and file SHA-256 hashes are pinned in the manifests. File sizes are disk bytes, not runtime RAM measurements. No new model has been enabled or claimed benchmarked on Windows by this inventory.

- Primary GGUF set: 10 checkpoints plus Muse-Glimmer vision projector, 196,835,527,136 bytes.
- Conversion staging: four additional distinct models, 40,537,504,993 bytes.
- Combined selected downloads: 237,373,032,129 bytes before conversion outputs and reserve.
- All 38 public repositories accounted for below. Alternate MLX and baseline copies are not additional distinct runnable Windows checkpoints.

See [download instructions](MODEL_DOWNLOADS.md). Downloads do not install runtimes or enable routes. Muse-Spark is excluded: its published MLX weights exceed the target machine’s memory before runtime overhead.

| Repository | Classification | Current repository bytes (all variants) |
|---|---|---:|
| [staccs/Apertus-70B-Instruct-2509-lecore-hrr](https://huggingface.co/staccs/Apertus-70B-Instruct-2509-lecore-hrr) | research not production checkpoint | 5429513 |
| [staccs/DeepSeek-R1-Distill-Llama-70B-lecore-GGUF](https://huggingface.co/staccs/DeepSeek-R1-Distill-Llama-70B-lecore-GGUF) | selected gguf checkpoint | 69714481412 |
| [staccs/DeepSeek-R1-Distill-Llama-70B-lecore-hrr](https://huggingface.co/staccs/DeepSeek-R1-Distill-Llama-70B-lecore-hrr) | research not production checkpoint | 23801 |
| [staccs/DeepSeek-R1-Distill-Llama-70B-lecore-mlx](https://huggingface.co/staccs/DeepSeek-R1-Distill-Llama-70B-lecore-mlx) | alternate platform duplicate | 26792377409 |
| [staccs/Llama-3.3-70B-Instruct-lecore-GGUF](https://huggingface.co/staccs/Llama-3.3-70B-Instruct-lecore-GGUF) | selected gguf checkpoint | 69721434246 |
| [staccs/Llama-3.3-70B-Instruct-lecore-hrr](https://huggingface.co/staccs/Llama-3.3-70B-Instruct-lecore-hrr) | research not production checkpoint | 5428275 |
| [staccs/Llama-3.3-70B-Instruct-lecore-mlx](https://huggingface.co/staccs/Llama-3.3-70B-Instruct-lecore-mlx) | alternate platform duplicate | 26812304517 |
| [staccs/Llama-3_3-Nemotron-Super-49B-v1_5-lecore-GGUF](https://huggingface.co/staccs/Llama-3_3-Nemotron-Super-49B-v1_5-lecore-GGUF) | selected gguf checkpoint | 49940388684 |
| [staccs/Llama-3_3-Nemotron-Super-49B-v1_5-lecore-hrr](https://huggingface.co/staccs/Llama-3_3-Nemotron-Super-49B-v1_5-lecore-hrr) | research not production checkpoint | 3334751 |
| [staccs/Llama-3_3-Nemotron-Super-49B-v1_5-lecore-mlx](https://huggingface.co/staccs/Llama-3_3-Nemotron-Super-49B-v1_5-lecore-mlx) | alternate platform duplicate | 19512445790 |
| [staccs/Muse-Glimmer-30B-lecore-GGUF](https://huggingface.co/staccs/Muse-Glimmer-30B-lecore-GGUF) | selected gguf checkpoint | 36627362352 |
| [staccs/Muse-Glimmer-30B-lecore-mlx](https://huggingface.co/staccs/Muse-Glimmer-30B-lecore-mlx) | alternate platform duplicate | 16035137360 |
| [staccs/Muse-Spark-Open-816B-A42B-lecore-mlx](https://huggingface.co/staccs/Muse-Spark-Open-816B-A42B-lecore-mlx) | excluded memory and format | 260289141747 |
| [staccs/QwQ-32B-lecore-GGUF](https://huggingface.co/staccs/QwQ-32B-lecore-GGUF) | selected gguf checkpoint | 32958613381 |
| [staccs/QwQ-32B-lecore-hrr](https://huggingface.co/staccs/QwQ-32B-lecore-hrr) | research not production checkpoint | 2754576 |
| [staccs/QwQ-32B-lecore-mlx](https://huggingface.co/staccs/QwQ-32B-lecore-mlx) | alternate platform duplicate | 13007462293 |
| [staccs/Qwen2.5-0.5B-lecore-infmem](https://huggingface.co/staccs/Qwen2.5-0.5B-lecore-infmem) | research not production checkpoint | 1224067103 |
| [staccs/Qwen2.5-72B-Instruct-lecore-GGUF](https://huggingface.co/staccs/Qwen2.5-72B-Instruct-lecore-GGUF) | selected gguf checkpoint | 78413127233 |
| [staccs/Qwen2.5-72B-Instruct-lecore-hrr](https://huggingface.co/staccs/Qwen2.5-72B-Instruct-lecore-hrr) | research not production checkpoint | 5430171 |
| [staccs/Qwen2.5-72B-Instruct-lecore-mlx](https://huggingface.co/staccs/Qwen2.5-72B-Instruct-lecore-mlx) | alternate platform duplicate | 26811422913 |
| [staccs/Qwen3-32B-lecore-19g-GGUF](https://huggingface.co/staccs/Qwen3-32B-lecore-19g-GGUF) | selected gguf checkpoint | 38399705464 |
| [staccs/Qwen3-32B-lecore-19g-mlx](https://huggingface.co/staccs/Qwen3-32B-lecore-19g-mlx) | alternate platform duplicate | 18640452919 |
| [staccs/Qwen3-32B-lecore-GGUF](https://huggingface.co/staccs/Qwen3-32B-lecore-GGUF) | selected gguf checkpoint | 32880590763 |
| [staccs/Qwen3-32B-lecore-hrr](https://huggingface.co/staccs/Qwen3-32B-lecore-hrr) | research not production checkpoint | 4351000 |
| [staccs/Qwen3-32B-lecore-mlx](https://huggingface.co/staccs/Qwen3-32B-lecore-mlx) | alternate platform duplicate | 13012219558 |
| [staccs/Qwen3.5-0.8B-lecore-assimilated](https://huggingface.co/staccs/Qwen3.5-0.8B-lecore-assimilated) | distinct model conversion needed | 1769911658 |
| [staccs/Qwen3.8-27B-lecore-GGUF](https://huggingface.co/staccs/Qwen3.8-27B-lecore-GGUF) | selected gguf checkpoint | 32024274441 |
| [staccs/Qwen3.8-27B-lecore-mlx](https://huggingface.co/staccs/Qwen3.8-27B-lecore-mlx) | alternate platform duplicate | 15471216761 |
| [staccs/Seed-OSS-36B-Instruct-lecore-mlx](https://huggingface.co/staccs/Seed-OSS-36B-Instruct-lecore-mlx) | distinct model conversion needed | 18999385896 |
| [staccs/gemma-3-27b-it-lecore-GGUF](https://huggingface.co/staccs/gemma-3-27b-it-lecore-GGUF) | selected gguf checkpoint | 28232701319 |
| [staccs/gemma-3-27b-it-lecore-hrr](https://huggingface.co/staccs/gemma-3-27b-it-lecore-hrr) | research not production checkpoint | 29615 |
| [staccs/gemma-3-27b-it-lecore-mlx](https://huggingface.co/staccs/gemma-3-27b-it-lecore-mlx) | alternate platform duplicate | 11828139289 |
| [staccs/holo-llm-hrr-attention](https://huggingface.co/staccs/holo-llm-hrr-attention) | research not production checkpoint | 592865663 |
| [staccs/lecore-303m-rerun](https://huggingface.co/staccs/lecore-303m-rerun) | research not production checkpoint | 11325443251 |
| [staccs/lecore-bge-assimilated](https://huggingface.co/staccs/lecore-bge-assimilated) | distinct model conversion needed | 1312714096 |
| [staccs/lecore-deepseek-v4-flash-hrr](https://huggingface.co/staccs/lecore-deepseek-v4-flash-hrr) | excluded incomplete overlay | 1071185143 |
| [staccs/lecore-hrr-gpt2](https://huggingface.co/staccs/lecore-hrr-gpt2) | research not production checkpoint | 4593206415 |
| [staccs/lecore-qwen35-9b-assimilated](https://huggingface.co/staccs/lecore-qwen35-9b-assimilated) | distinct model conversion needed | 19329320082 |

## Acceptance before routing

Verify downloaded size/hash, then perform bounded local model loading, generation, chat-template/EOS, context and memory tests. Independently validate tools, structured output, embeddings and vision before advertising them. Architecture support is not a successful model-load test. Each running process reserves its own weights and runtime memory, even when it uses the same disk file.

Qwen3.5 and BGE staging preserves the original safetensors and supporting assets. The Qwen 0.8B layout metadata must be preserved and fidelity checked. Seed-OSS MLX affine quantization requires a reviewed dequantization/conversion path; native architecture support alone is insufficient. No custom model code, pickle checkpoint, wallet or credentials are fetched or executed.

Sources: [Hugging Face author API](https://huggingface.co/api/models?author=staccs), the repository links above, and the immutable revision/file metadata in each manifest. Model-card quality claims are not independently verified performance results.
