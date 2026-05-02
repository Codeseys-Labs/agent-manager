---
status: proposed | accepted | deprecated | superseded
date: YYYY-MM-DD
superseded_by: ADR-NNNN (if applicable)
# Use `amended_by` when a later ACCEPTED ADR corrects a specific aspect of
# this one without fully superseding it. The amended ADR stays `accepted`;
# a reader consulting it is directed to the companion ADR for the correction.
# Repeat as array when multiple ADRs amend different aspects.
amended_by: ADR-NNNN (if applicable; array allowed)
# Use `pending_amendment_by` when the amending ADR is still `proposed`.
# An `accepted` ADR cannot defer authoritatively to a non-accepted one —
# that would make load-bearing policy depend on a draft. Forward-reference
# the proposed amendment so readers see the in-flight change without
# treating it as settled. Flip `pending_amendment_by` → `amended_by` when
# the referenced ADR is promoted to `accepted`.
pending_amendment_by: ADR-NNNN (if applicable)
---

# ADR-NNNN: Title

## Context

What is the issue that we're seeing that is motivating this decision or change?

## Decision

What is the change that we're proposing and/or doing?

## Consequences

What becomes easier or more difficult to do because of this change?

### Positive

### Negative

### Neutral

## Alternatives Considered

What other options were explored and why were they rejected?

## References

- Links to research docs, prior art, relevant discussions
