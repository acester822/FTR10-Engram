/*
 - filename: packages/engram-js/src/api/routes/ingest/document/route.ts
 - what is the file used for: registers post /ingest/document for text, html, url, and base64 ingestion
*/

import { createExtractionCandidate, createWorkingMemoryEvent } from "../../../../durable/repository";
import {
  OptionalExtractorUnavailable,
  extractDocumentContent,
  extractUrlContent,
  extractionToCandidateInputs,
} from "../../../../ingestion/extract";
import { bad, fail, obj, type doc_req, type route_ctx } from "../../_kit";
import { env } from "../../../../configuration/index";

export const ingest_document_route = (app: any, ctx: route_ctx) => {
  app.post("/ingest/document", async (req: any, res: any) => {
    const body = (req.body || {}) as doc_req;
    if (body.url !== undefined && typeof body.url !== "string")
      return bad(res, "url", "url must be a string");
    if (body.data !== undefined && typeof body.data !== "string")
      return bad(res, "data", "data must be a string");
    if (!body.url && !body.data) return bad(res, "data", "data or url is required");
    if (!body.url && (typeof body.content_type !== "string" || body.content_type.trim().length === 0))
      return bad(res, "content_type", "content_type is required when data is provided");
    if (body.encoding !== undefined && !["text", "base64"].includes(body.encoding))
      return bad(res, "encoding", "encoding must be text or base64");
    if (body.metadata !== undefined && !obj(body.metadata))
      return bad(res, "metadata", "metadata must be an object");
    if (body.contracts !== undefined && !obj(body.contracts))
      return bad(res, "contracts", "contracts must be an object");

    try {
      const content = body.url
        ? await extractUrlContent(body.url)
        : await extractDocumentContent(
            body.content_type || "text/plain",
            body.encoding === "base64" ? Buffer.from(body.data || "", "base64") : body.data || "",
          );
      const source = {
        kind: body.source?.kind || (body.url ? "url" : "document"),
        uri: body.source?.uri || body.url,
        id: body.source?.id,
        content_type: body.source?.content_type || content.metadata.content_type,
      };
      const event = await createWorkingMemoryEvent(ctx.db, {
        user_id: body.user_id,
        project_id: body.project_id,
        source,
        content: content.text,
        metadata: { ...body.metadata, ...content.metadata },
        contracts: body.contracts,
        observed_at: body.observed_at,
      });

      // Split oversized documents into paragraph-aware chunks so each
      // candidate fits within embedding context and stays individually
      // reviewable via /ingest/candidates/{accept,reject}. The shared
      // event_id ties all chunk candidates back to the same source event.
      const candidateInputs = extractionToCandidateInputs(
        {
          event_id: event.id,
          user_id: body.user_id,
          project_id: body.project_id,
          source: { kind: source.kind, uri: source.uri, id: source.id, observed_at: body.observed_at },
          content,
          metadata: body.metadata,
          contracts: body.contracts,
        },
        { target_chars: env.ingest_chunk_target_chars },
      );

      const candidates = [];
      for (const input of candidateInputs) {
        candidates.push(await createExtractionCandidate(ctx.db, input));
      }

      if (candidates.length === 1) {
        return res.json({ adapter: "durable-postgres", event, candidate: candidates[0] });
      }
      return res.json({
        adapter: "durable-postgres",
        event,
        candidates,
        chunked: true,
        chunk_count: candidates.length,
      });
    } catch (e: unknown) {
      if (e instanceof OptionalExtractorUnavailable)
        return res.status(422).json({
          err: "extractor_unavailable",
          content_type: e.content_type,
          install_hint: e.install_hint,
        });
      fail(res, "document_ingest_failed", e);
    }
  });
};
