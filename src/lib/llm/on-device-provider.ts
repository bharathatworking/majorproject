import type { LLMAvailability } from '../../types';

declare global {
  interface Window {
    LanguageModel?: {
      availability(options?: LanguageModelOptions): Promise<LLMAvailability>;
      create(options: LanguageModelOptions & { initialPrompts?: any[]; monitor?: (m: any) => void }): Promise<any>;
    };
  }
}

interface LanguageModelOptions {
  expectedInputs?: Array<{ type: 'text'; languages: string[] }>;
  expectedOutputs?: Array<{ type: 'text'; languages: string[] }>;
}

// Shared across both calls on purpose — Chrome's docs require availability()
// and create() to be passed matching options, or availability can report a
// status that doesn't reflect what create() actually does.
const LANGUAGE_OPTIONS: LanguageModelOptions = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

export class OnDeviceLLMProvider {
  private baseSession: any = null;

  async checkAvailability(): Promise<LLMAvailability> {
    if (typeof window.LanguageModel === 'undefined') return 'unavailable';
    try {
      return await window.LanguageModel.availability(LANGUAGE_OPTIONS);
    } catch (e) {
      console.error('Failed to check LanguageModel availability', e);
      return 'unavailable';
    }
  }

  async createBaseSession(
    systemText: string,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<void> {
    if (!window.LanguageModel) throw new Error('LanguageModel API not available');
    this.baseSession = await window.LanguageModel.create({
      initialPrompts: [{ role: 'system', content: systemText }],
      ...LANGUAGE_OPTIONS,
      monitor(m: any) {
        m.addEventListener('downloadprogress', (e: any) => {
          if (onProgress) onProgress(e.loaded, e.total);
        });
      },
    });
  }

  async simplifyChunk(userText: string): Promise<AsyncIterable<string>> {
    if (!this.baseSession) throw new Error('Session not created');
    const chunkSession = await this.baseSession.clone();
    const stream = chunkSession.promptStreaming(userText);
    return (async function* () {
      try {
        for await (const chunk of stream) yield chunk;
      } finally {
        if (typeof chunkSession.destroy === 'function') chunkSession.destroy();
      }
    })();
  }

  destroy() {
    if (this.baseSession && typeof this.baseSession.destroy === 'function') {
      this.baseSession.destroy();
    }
    this.baseSession = null;
  }
}
