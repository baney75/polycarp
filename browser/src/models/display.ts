/**
 * Readable names for providers and models, for the composer's model button and the provider
 * list. The raw id stays available (tooltips); these are for reading at a glance.
 */

const PROVIDER_NAMES: Record<string, string> = {
	anthropic: "Anthropic",
	cerebras: "Cerebras",
	// Subscription sign-ins (src/subscriptions): the name says whose plan pays.
	"chatgpt-plan": "ChatGPT plan",
	"copilot-plan": "GitHub Copilot plan",
	deepseek: "DeepSeek",
	"github-copilot": "GitHub Copilot",
	google: "Google",
	groq: "Groq",
	huggingface: "Hugging Face",
	"llama.cpp": "llama.cpp",
	lmstudio: "LM Studio",
	minimax: "MiniMax",
	"minimax-cn": "MiniMax (China)",
	mistral: "Mistral",
	ollama: "Ollama",
	openai: "OpenAI",
	openrouter: "OpenRouter",
	"vercel-ai-gateway": "Vercel AI Gateway",
	vllm: "vLLM",
	xai: "xAI",
	zai: "Z.ai",
};

/** Words in model ids with a fixed spelling. */
const WORDS: Record<string, string> = {
	ai: "AI",
	claude: "Claude",
	deepseek: "DeepSeek",
	gemini: "Gemini",
	gemma: "Gemma",
	glm: "GLM",
	gpt: "GPT",
	grok: "Grok",
	kimi: "Kimi",
	llama: "Llama",
	minimax: "MiniMax",
	mistral: "Mistral",
	oss: "OSS",
	qwen: "Qwen",
	r1: "R1",
	vl: "VL",
};

/** A provider id as people write it; custom provider names are the user's own and kept. */
export function providerDisplayName(provider: string): string {
	const known = PROVIDER_NAMES[provider.toLowerCase()];
	if (known) return known;
	if (/[A-Z ]/.test(provider)) return provider;
	return provider
		.split(/[-_]/)
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(" ");
}

function prettyWord(word: string): string {
	const lower = word.toLowerCase();
	if (WORDS[lower]) return WORDS[lower];
	// OpenAI's o-series (o3, o4) is written lower case.
	if (/^o\d/.test(lower)) return lower;
	// Sizes and versions: 8b -> 8B, 70b -> 70B, v4.1 -> V4.1, a3b -> A3B.
	if (/^\d+(\.\d+)?[bkm]$/.test(lower) || /^a\d+b$/.test(lower)) return lower.toUpperCase();
	if (/^v\d/.test(lower)) return `V${lower.slice(1)}`;
	return word[0].toUpperCase() + word.slice(1);
}

/** A model id made readable: the last path part, no date stamp, words spelled out. */
function prettyId(id: string): string {
	let base = id.split("/").at(-1) ?? id;
	let free = false;
	if (base.endsWith(":free")) {
		free = true;
		base = base.slice(0, -":free".length);
	}
	base = base.replace(/:latest$/, "");
	// Date stamps: -2024-08-06, -20241022, -0528, -1017.
	base = base.replace(/-(\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$/, "");
	const words = base
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map(prettyWord);
	// "GPT 4o" is written "GPT-4o".
	const joined: string[] = [];
	for (const w of words) {
		if (joined.at(-1) === "GPT") joined[joined.length - 1] = `GPT-${w}`;
		else joined.push(w);
	}
	const name = joined.join(" ") || id;
	return free ? `${name} (free)` : name;
}

/**
 * The name to show for a model. A curated name is used when there is one ("DeepSeek: DeepSeek
 * V3" loses its vendor prefix, which the provider already says); a name that is only the id
 * again, as runtime discovery leaves it, is made readable from the id.
 */
export function modelDisplayName(model: { id: string; name?: string }): string {
	const name = model.name?.trim();
	if (name && name !== model.id) {
		const prefixed = /^([^:]{1,30}):\s+(.+)$/.exec(name);
		return prefixed ? prefixed[2] : name;
	}
	return prettyId(model.id);
}

/** The composer's model label: readable name, provider, and the full id for the tooltip. */
export function modelLabelParts(model: { id: string; name?: string; provider: string }): {
	name: string;
	provider: string;
	title: string;
} {
	const provider = providerDisplayName(model.provider);
	return {
		name: modelDisplayName(model),
		provider,
		title: `${provider} · ${model.id}\nChange model`,
	};
}
