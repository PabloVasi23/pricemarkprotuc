import { GoogleGenAI, Type } from "@google/genai";

const EXTRACTION_PROMPT = `Extract all distinct product names, their brands or variants, and their unit prices.
Rules:
1. Extract 'name' (primary identity).
2. Extract 'brand' (manufacturer or variant).
3. Extract 'originalPrice' as a clean number.
4. Identify 'currency'.
5. Return ONLY a JSON object with an array 'items'.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          brand: { type: Type.STRING },
          originalPrice: { type: Type.NUMBER },
          currency: { type: Type.STRING },
        },
        required: ["name", "brand", "originalPrice", "currency"],
      },
    },
  },
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // REQUISITO: La variable de entorno configurada en Vercel es 'price_mark_key'
  const apiKey = process.env.price_mark_key;

  if (!apiKey) {
    console.error("Critical: price_mark_key environment variable is missing.");
    return res.status(500).json({ error: 'Configuración de API incompleta en el servidor' });
  }

  const { action, payload } = req.body;
  
  // Instanciamos el SDK de Google GenAI
  const ai = new GoogleGenAI({ apiKey });

  try {
    if (action === 'extractFromImage') {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: {
          parts: [
            { inlineData: { data: payload.base64, mimeType: payload.mimeType } },
            { text: EXTRACTION_PROMPT }
          ],
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      });
      return res.status(200).json(JSON.parse(response.text || "{}"));
    }

    if (action === 'cleanMessyData') {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Clean this messy data:\n${payload.rawData}\n\n${EXTRACTION_PROMPT}`,
        config: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      });
      return res.status(200).json(JSON.parse(response.text || "{}"));
    }

    if (action === 'extractFromUrl') {
      // Usamos gemini-3-pro-preview para búsqueda web
      const response = await ai.models.generateContent({
        model: "gemini-3-pro-preview",
        contents: `Extract prices from this URL: ${payload.url}\n\n${EXTRACTION_PROMPT}`,
        config: { tools: [{ googleSearch: {} }] },
      });

      const text = response.text || "";
      // Extractor robusto de bloques JSON de la respuesta de texto
      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/) || text.match(/\{[\s\S]*\}/);
      let items = [];
      try {
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
          items = parsed.items || [];
        }
      } catch (e) {
        console.error("Error al parsear salida de IA:", text);
      }
      
      const sources = response.candidates?.[0]?.groundingMetadata?.groundingChunks
        ?.filter(c => c.web?.uri)
        .map(c => ({ uri: c.web!.uri, title: c.web!.title || c.web!.uri })) || [];

      return res.status(200).json({ items, sources });
    }

    return res.status(400).json({ error: 'Acción no válida' });
  } catch (error: any) {
    console.error("Vercel Proxy Error:", error);
    return res.status(500).json({ error: 'Error procesando la solicitud con IA' });
  }
}