import type { EngramSettings } from '../types';

let settings: EngramSettings | null = null;

export function setOllamaSettings(s: EngramSettings): void {
  settings = s;
}

function getSettings(): EngramSettings {
  if (!settings) throw new Error('Ollama settings not initialized');
  return settings;
}

export async function embed(text: string): Promise<number[]> {
  const { ollamaUrl, ollamaModel } = getSettings();
  const res = await fetch(`${ollamaUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ollamaModel, prompt: text }),
  });

  if (!res.ok) {
    throw new Error(`Ollama embedding failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { embedding: number[] };
  return data.embedding;
}

export async function isOllamaRunning(): Promise<boolean> {
  try {
    const { ollamaUrl } = getSettings();
    const res = await fetch(`${ollamaUrl}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}
