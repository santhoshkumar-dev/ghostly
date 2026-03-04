export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AIRequestOptions {
  base64Image: string;
  mimeType?: string;
  prompt: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
}

export interface AIProvider {
  name: string;
  streamSolution(options: AIRequestOptions): AsyncGenerator<string>;
  listModels(): string[];
}
