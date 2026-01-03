
import { ExtractedData } from "../types";

const callProxy = async (action: string, payload: any): Promise<any> => {
  const response = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Error en el servidor de IA');
  }

  return response.json();
};

export const extractPricesFromImage = async (base64Image: string, mimeType: string): Promise<ExtractedData> => {
  return callProxy('extractFromImage', { base64: base64Image, mimeType });
};

export const cleanMessyDataWithAI = async (rawData: string): Promise<ExtractedData> => {
  return callProxy('cleanMessyData', { rawData });
};

export const extractPricesFromUrl = async (url: string): Promise<ExtractedData> => {
  return callProxy('extractFromUrl', { url });
};
