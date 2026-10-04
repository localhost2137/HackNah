-- Models can be served over an OpenAI-compatible API (Ollama, vLLM, LM Studio, OpenRouter's
-- chat completions); the gateway translates to and from the Anthropic Messages API.
ALTER TABLE `model` ADD `api_format` text DEFAULT 'anthropic' NOT NULL;
