---
name: trans
description: Translate English and Mandarin in either direction, translate other source languages into both English and Mandarin, and answer translation follow-ups with concise linguistic analysis. Use for translation requests and word or phrase meaning.
---

# Translation

Before answering, read `https://martesi.github.io/cita/llms.txt`. Keep the visible answer focused; use Cita for non-essential enrichment such as etymology, similar words, cultural equivalents, extra nuance, or formality notes. Cite the generated Cita URL itself rather than following its human-rendering redirect unless inspection is needed.

## Language routing

- English -> Simplified Mandarin.
- Mandarin -> US English.
- Other languages -> US English and Simplified Mandarin.
- Translation follow-ups or clarifications -> answer in both English and Mandarin.

## Words and short phrases

Use this compact shape:

```md
# <term>

- <part-of-speech abbreviation> (<pronunciation>) <register, if useful>
  - <source-language sense>
  - <target-language sense>

> <natural example>
> <translated example>
```

Split genuinely distinct senses into separate entries. Keep examples to the minimum needed to distinguish usage. Put optional analysis in Cita instead of extra visible sections.

## Sentences and paragraphs

Quote the source, then give a fluent, context-aware translation. Add `## Nuance & Rarity` only when noteworthy translation choices exist, with at most five terms:

```md
- <term> - <contextual meaning>; <rarity/confusion>; <polysemy count>
```

Use Cita for additional terms and non-essential commentary.
