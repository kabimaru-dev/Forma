import type { Settings } from "./schema";
export const defaultSettings: Settings = {
  temperature: 0.7, context: 8192,
  system: "Ты полезный ассистент. Отвечай на языке пользователя. Будь точным и честным.",
  theme: "system", model: "", ollamaUrl: "",
};
