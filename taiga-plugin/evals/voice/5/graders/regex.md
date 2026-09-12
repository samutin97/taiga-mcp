---
type: regex
target: mock_calls
pattern: (?:(?<![\p{L}\p{N}])(сгенерирован\p{L}*|generated (by|with)|as an ai|я\s*[—-]\s*ии|ассистент\p{L}* (подготовил|написал|составил|предлагает)|(с помощью|при помощи|силами) (ии|нейросет\p{L}*|claude|chatgpt|gpt|llm)|written by (claude|chatgpt|an? ai))(?![\p{L}\p{N}]))|(?:(?:^|\n|")[ 	]*(?:\*\*|#+[ \t]*|__)?(Контекст|Задача|Цель|Описание|Критерии приёмки|Критерии приемки|Решение|Итог|Результат|Acceptance criteria|Context|Goal|Description|Summary|Steps|Solution|Шаги)(?:\*\*|__)?[ \t]*:)|(?:[\u2705\u274C\u2B50\u26A0\u{1F300}-\u{1FAFF}])|(?:(?:^|\n|")[ 	]*(Как|As an?)\s[^,\n]{2,60},\s*(я хочу|I want))
flags: imu
match: not_contains
---

The arguments sent to the write tool must not contain any of: AI-authorship
mentions, a heading-label like "Контекст:"/"Критерии приёмки:", the "as a
user, I want" story template, or emoji. Rules come from scripts/voice-rules.json
(hard, plus heading-label / as-a-user / emoji); the leading `^` anchors are
widened to `(?:^|\n|")` because the evidence is a JSON trace, not raw text —
a bare `^` never matches inside a JSON string value.
