# Yearbook Keywords Module Design Brief

This note documents the Yearbook `top_words` and `signature` module so Mac and
Windows work stay aligned.

## Purpose

The double-person Yearbook page should answer three quick questions for each
year:

- What did we talk about most that year?
- Is there one reviewable slice that can bring the user back to that period?
- Why did the algorithm choose that slice?

## Data Contract

`YearData` may include:

```ts
top_words?: Array<{ word: string; count: number }>;
signature: {
  date: string;
  from: string;
  from_id?: string;
  text: string;
  reason?: string;
  terms?: string[];
} | null;
```

The quote sender should carry `from_id` whenever possible so privacy mode can
mask names correctly. `signature.reason` and `signature.terms` are explanatory
metadata, not proof that the selected quote summarizes the entire relationship.

## UI Intent

- Keep the module compact and scannable.
- Show only the top handful of words by default.
- Clamp the signature quote to a few lines.
- Present the reason as an algorithm explanation, not as ordinary body text.
- Avoid colorful word-cloud styling; use one accent plus neutral text.

## Cache Boundary

Changing these fields requires a yearbook cache bump. Current shared cache
version is `YEARBOOK_CACHE_VERSION = 5`.
