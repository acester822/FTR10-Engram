import { runMiddleware, cors } from "@/src/features/public-api/server/cors";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, cors);

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const resp = await fetch("http://engram:8080/api/performance/system", {
      headers: { "x-api-key": process.env.EG_INTERNAL_API_KEY || "" },
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      return res.status(resp.status).json({ error: `Engram returned ${resp.status}` });
    }

    const data = await resp.json();
    return res.status(200).json(data);
  } catch (e) {
    console.error("Engram performance fetch failed", e);
    return res.status(502).json({ error: e instanceof Error ? e.message : "Failed to reach Engram" });
  }
}
