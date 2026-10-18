import { z } from "zod";
import { num, obj } from "./_base";

/** Error codes the Burrow backend emits (docs/contracts/api.md §1). `code` stays a lenient string in the schema. */
export const API_ERROR_CODES = [
  "upstream_unreachable",
  "upstream_status",
  "not_found",
  "bad_request",
  "forbidden",
  "unavailable",
  "internal",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Burrow's own error envelope for non-2xx responses it produces. */
export const ApiErrorEnvelopeSchema = obj({
  error: obj({
    code: z.string(),
    message: z.string(),
    upstream: obj({ url: z.string(), status: num }).optional(),
    hint: z.string().optional(),
  }),
});
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;

/** Hadoop `RemoteExceptionData` — passed through unchanged with the upstream status. */
export const RemoteExceptionSchema = obj({
  RemoteException: obj({
    exception: z.string(),
    message: z.string().optional(),
    javaClassName: z.string().optional(),
  }),
});
export type RemoteException = z.infer<typeof RemoteExceptionSchema>;
