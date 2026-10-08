import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatApiError, refToToolCall } from "../src/hints.js";

describe("refToToolCall", () => {
  test("maps operations to tools and renames path params", () => {
    assert.equal(refToToolCall({ op: "list_properties", params: { space_id: "s" } }), 'anytype_list_properties {"space_id":"s"}');
    assert.equal(
      refToToolCall({ op: "get_query_objects", params: { space_id: "s", query_id: "q" } }),
      'anytype_list_items {"space_id":"s","list_id":"q"}',
    );
    assert.equal(refToToolCall({ op: "get_object", query: { format: "md" } }), "anytype_fetch");
    assert.equal(refToToolCall({ op: "search_space", query: { limit: "5" } }), 'anytype_search {"limit":5}');
  });

  test("a ref without op means retrying the same call", () => {
    assert.equal(refToToolCall({ query: { dry_run: "false" } }), "retry the same call with dry_run: false");
    assert.equal(refToToolCall({}), "retry the same call");
  });

  test("unknown operations are named as unavailable", () => {
    assert.equal(refToToolCall({ op: "create_widget" }), "create_widget (not available as a tool)");
  });
});

describe("formatApiError", () => {
  test("plain bodies", () => {
    assert.equal(formatApiError(502, "Bad gateway"), "Anytype API 502: Bad gateway");
    assert.equal(formatApiError(500, undefined), "Anytype API 500: request failed");
  });

  test("status hints when Anytype gives no issues", () => {
    assert.match(formatApiError(401, { code: "unauthorized", message: "Unauthorized" }), /new one/);
    assert.match(formatApiError(403, { code: "forbidden", message: "Forbidden" }), /anytype_list_spaces/);
    assert.match(formatApiError(404, { code: "not_found", message: "object not found" }), /anytype_search/);
  });

  test("issues replace the generic status hint", () => {
    const text = formatApiError(404, { code: "not_found", message: "no block contains", issues: [{ message: "copy the text exactly" }] });
    assert.equal(text, "Anytype API 404: no block contains (not_found)\n- copy the text exactly");
  });
});
