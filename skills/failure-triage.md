---
name: Hata analizi ve raporlama
description: Düşen koşumu açıklama, kök neden sınıfı, önem derecesi, bug raporu ve sonraki koşum önerisi.
triggers: neden, niye, dustu, dusmus, basarisiz, failed, fail, hata, hatali, bug, sorun, problem, rapor, raporla, sonuc, ne oldu, gecti mi, analiz, incele, flaky, tekrar dene, yeniden dene
---
# Failure triage and reporting

Answer from `conversation` (each run lists its cases, status, `failedStep` and, for chat scenarios, the steps). Never guess beyond the evidence; say what is known and what would confirm it.

## Classify the cause (pick one, say why)
- **Product bug** — the app itself misbehaved: error page/500, wrong result, expected message missing while the preceding steps clearly succeeded, data not saved. The assertion step failed with a coherent "Reason".
- **Test/step issue** — the step could not be done as written: element "not visible/not found", ambiguous wording, a popup/overlay blocked the tap, the flow has an extra screen (two-step login, onboarding). Fix = better step wording or an added conditional/dismiss step.
- **Environment** — `ERR_CONNECTION_*`, DNS, timeouts, 502/503, device not available, DRM/codec limits, app not installed. Fix = check the environment/device and re-run; not a product bug yet.
- **Test data** — no free test user, locked or wrong test account, missing product/content. Fix = free/add accounts in the source, pick other data.
- **Model/tooling** — 401/403 from the model, "AI model request failed", planning loops. Fix = check Settings → Model.
- **Flaky suspicion** — the same case passed earlier in the conversation, only a timing step failed, or a step says "2. denemede geçti" (the runner retried it once); recommend one re-run before filing a bug.
- **Timeout** — detail says "zaman aşımı": the step hung (page never settled, an endless spinner, a blocked modal). Look at the step screenshot; often an environment or overlay issue, sometimes a real performance bug.
- **Value mismatch** — detail says `Beklenen "…", ekranda okunan "…"`: a read step with `expect` found a different value. Usually a product bug (wrong price/total/text); confirm the read prompt was specific enough.

## Severity (for product bugs)
- **critical** — blocks a core workflow for everyone, data loss, security/privacy exposure (e.g. login impossible, checkout broken).
- **high** — a major feature broken without workaround (search returns nothing, upload silently fails, auth redirect loop).
- **medium** — works with noticeable problems or a workaround exists (validation missing, very slow, layout broken on one viewport).
- **low** — cosmetic/copy (typo, alignment).

## Reply shape
- One line verdict: "#<id> <status>: <case> <step> adımında düştü".
- Cause class + evidence (quote the step and its detail briefly).
- Next action: concrete and runnable — e.g. "adımı 'Giriş formu görünmüyorsa Hesabım menüsünü aç' diye güncelleyip tekrar koşayım mı?", "ortam 503 veriyor, 5 dk sonra tekrar koş", or a bug report.
- Bug report when it is a product bug:
  - **Başlık** (short, specific) · **Önem** · **Ortam** (project/configuration/platform)
  - **Adımlar** (numbered, from the run's steps; credentials as `[gizli]`)
  - **Beklenen** · **Gerçekleşen** · **Kanıt**: "Koşum #<id> raporu ve adım ekran görüntüsü"
- If the tester asks to retry or fix the steps, return a `scenario` (or `run_suite`) instead of a reply, reusing the previous target and changing only what is needed.
