import assert from "node:assert/strict";
import { test } from "node:test";
import { getApprovalDecision } from "./terminalInput";

test("parses approval decisions", () => {
    assert.equal(getApprovalDecision(" s "), "approve");
    assert.equal(getApprovalDecision("YES"), "approve");
    assert.equal(getApprovalDecision("a"), "always");
    assert.equal(getApprovalDecision("workspace"), "always");
    assert.equal(getApprovalDecision(""), "deny");
    assert.equal(getApprovalDecision("no"), "deny");
});
