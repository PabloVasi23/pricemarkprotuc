
import { GoogleGenAI, Type } from "@google/genai";
import { ExtractedData } from "../types";

const EXTRACTION_PROMPT = `Extract all distinct product names, their brands or variants (if identifiable), and their unit prices.

SPECIFIC PATTERN HANDLING:
- The input data may follow this format: "PRODUCT NAME X QUANTITY, DESCRIPTION/BRAND $ PRICE".
- Example: "HIGH ENERGY GEL X 24UN, GOMITAS $ 163.308,00" 
  -> Name: "HIGH ENERGY GEL X 24UN"
  -> Brand/Variant: "GOMITAS"
  -> Price: 163308.00

IMPORTANT RULES:
1. Extract the 'name' as the primary product identity.
2. Extract 'brand' as the manufacturer or the specific variant mentioned after the comma.
3. Extract 'originalPrice' as a clean number (remove currency symbols, dots as thousands, and commas as decimals).
4. Identify the 'currency' (e.g., $, €, £). Default to '$'.
5. Return ONLY a JSON object with an array 'items'.
6. Ignore any totals or irrelevant text headers.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: "The primary name and presentation of the product" },
          brand: { type: Type.STRING, description: "The brand, manufacturer or variant" },
          originalPrice: { type: Type.NUMBER, description: "The clean numerical price" },
          currency: { type: Type.STRING, description: "The currency symbol" },
        },
        required: ["name", "brand", "originalPrice", "currency"],
      },
    },
  },
};

export const extractPricesFromImage = async (base64Image: string, mimeType: string): Promise<ExtractedData> => {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [
          {
            inlineData: {
              data: base64Image,
              mimeType: mimeType,
            },
          },
          {
            text: EXTRACTION_PROMPT + "\n\nOutput valid JSON.",
          },
        ],
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    if (response.text) {
      return JSON.parse(response.text) as ExtractedData;
    }
    
    throw new Error("No data returned from AI");
  } catch (error) {
    console.error("Gemini Image Extraction Error:", error);
    throw error;
  }
};

export const cleanMessyDataWithAI = async (rawData: string): Promise<ExtractedData> => {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `I have messy data from a CSV scraper. All info (name, brand, and price) is mixed in strings. 
      Use human-like intelligence to parse them.
      
      MESSY DATA:
      ${rawData}
      
      ${EXTRACTION_PROMPT}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    if (response.text) {
      return JSON.parse(response.text) as ExtractedData;
    }
    throw new Error("No cleanup data returned");
  } catch (error) {
    console.error("Gemini Messy Data Cleanup Error:", error);
    throw error;
  }
};

export const extractPricesFromUrl = async (url: string): Promise<ExtractedData> => {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: `Search for the current product prices at this URL: ${url}. 
      
      Instructions:
      1. Find the product names, brands/variants, and their respective unit prices.
      2. Format the results as a JSON object containing an array named 'items'.
      3. If the page is not accessible or no products are found, explain why briefly.
      
      JSON Format example:
      {"items": [{"name": "Sample Product", "brand": "Brand X", "originalPrice": 12.50, "currency": "$"}]}
      
      ${EXTRACTION_PROMPT}`,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const text = response.text || "";
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/) || text.match(/\{[\s\S]*\}/);
    let items: any[] = [];
    
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        items = (parsed.items || []).map((i: any) => ({
          name: String(i.name || ""),
          brand: String(i.brand || ""),
          originalPrice: Number(i.originalPrice || 0),
          currency: String(i.currency || "$")
        }));
      } catch (e) {
        console.warn("Failed to parse JSON from response", e);
      }
    } else if (!text) {
      throw new Error("The model did not return any text. This might be due to access restrictions on the URL.");
    }

    const sources: { uri: string; title: string }[] = [];
    const candidates = response.candidates;
    if (candidates && candidates.length > 0) {
      const groundingMetadata = candidates[0].groundingMetadata;
      if (groundingMetadata && groundingMetadata.groundingChunks) {
        for (const chunk of groundingMetadata.groundingChunks) {
          if (chunk.web?.uri) {
            sources.push({
              uri: chunk.web.uri,
              title: chunk.web.title || chunk.web.uri
            });
          }
        }
      }
    }

    return { items, sources };
  } catch (error) {
    console.error("Gemini URL Extraction Error:", error);
    throw error;
  }
};
