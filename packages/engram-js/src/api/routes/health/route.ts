/*
 - filename: packages/engram-js/src/api/routes/health/route.ts
 - what is the file used for: registers the public health route with storage, vector, and embedding runtime info
*/

import { env } from "../../../configuration";
import { getEmbeddingInfo } from "../../../embeddings/embed";
import { getVectorStoreInfo } from "../../../vectorStores";

export const health_route = (app: any) => {
  app.get("/health", async (_req: any, res: any) => {
    res.json({
      ok: true,
      version: "2.0-durable",
      metadata_backend: env.storage_backend,
      vector_store: getVectorStoreInfo(),
      embedding: getEmbeddingInfo(),
      dim: env.vec_dim,
    });
  });
};
