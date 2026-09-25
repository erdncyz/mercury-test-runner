import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { caseSkillText, loadSkills, midsceneContext, midsceneNotes, parseSkill, selectSkills, skillPrompt } from "../src/skills.mjs";

const builtinDir = fileURLToPath(new URL("../skills", import.meta.url));
const ids = (list) => list.map((skill) => skill.id);

test("beceri ön bilgisi okunur; tetikleyiciler katlanır", () => {
  const skill = parseSkill("---\nname: Deneme\ndescription: d\ntriggers: Giriş, Sepet , ÖDEME\nalways: false\n---\n# Gövde\nmetin", "deneme");
  assert.deepEqual([skill.name, skill.always, skill.triggers, skill.body], ["Deneme", false, ["giris", "sepet", "odeme"], "# Gövde\nmetin"]);
  assert.equal(parseSkill("ön bilgisiz metin", "x").body, "ön bilgisiz metin");
  assert.equal(parseSkill("---\nalways: true\n---\nx", "x").always, true);
});

test("yerleşik beceriler yüklenir: QA çekirdeği her zaman, diğerleri tetikleyiciyle", () => {
  const skills = loadSkills([builtinDir]);
  for (const id of ["qa-core", "auth-login", "signup-reset", "search-filter", "cart-checkout", "forms-validation", "smoke-exploratory", "media-playback", "mobile-app", "failure-triage", "visual-content-a11y"]) {
    assert.ok(skills.some((skill) => skill.id === id), id);
  }
  assert.ok(skills.every((skill) => skill.always || skill.triggers.length), "her beceri seçilebilir");
  assert.deepEqual(ids(skills.filter((skill) => skill.always)), ["qa-core"]);

  assert.deepEqual(ids(selectSkills(skills, ["selam"])), ["qa-core"]);
  assert.deepEqual(ids(selectSkills(skills, ["Örnek Proje'de login ol"])), ["qa-core", "auth-login"]);
  assert.ok(ids(selectSkills(skills, ["girişe tıkla ve sepetime git"])).includes("cart-checkout"), "Türkçe ekler tetikleyiciyi bozmaz");
  assert.ok(ids(selectSkills(skills, ["son koşum neden düştü?"])).includes("failure-triage"));
  assert.ok(ids(selectSkills(skills, ["uygulamada video oynat"])).includes("media-playback"));
  assert.ok(ids(selectSkills(skills, ["bir de hatalı şifreyle dene", "Örnek Proje'de login ol"])).includes("auth-login"), "önceki tur da beceri seçtirir");
});

test("özel beceri yerleşiği ezer; bütçe dolunca düşük puanlı beceri eklenmez", () => {
  const custom = mkdtempSync(join(tmpdir(), "mtr-skills-"));
  writeFileSync(join(custom, "auth-login.md"), "---\nname: Bizim giriş\ntriggers: login\n---\nGiriş Hesabım menüsünde.");
  writeFileSync(join(custom, "proje.md"), "---\nname: Proje\ntriggers: kampanya\n---\nKampanya sayfası /firsatlar.");
  const skills = loadSkills([builtinDir, custom]);
  const login = skills.find((skill) => skill.id === "auth-login");
  assert.deepEqual([login.name, login.source], ["Bizim giriş", "custom"]);
  assert.ok(ids(selectSkills(skills, ["kampanya sayfasını test et"])).includes("proje"));

  const small = selectSkills(skills, ["login ol ve kampanya sayfasına bak"], 10);
  assert.deepEqual(ids(small), ["qa-core"], "her zaman kullanılan beceri bütçeden bağımsızdır");
  const prompt = skillPrompt(selectSkills(skills, ["login ol"]));
  assert.match(prompt, /<skill name="QA çekirdeği">/);
  assert.match(prompt, /<skill name="Bizim giriş">\nGiriş Hesabım menüsünde\./);
});

test("becerilerin ## Midscene bölümü Midscene bağlamına dönüşür; kayıtlı case kendi başlığıyla beceri seçer", () => {
  const skill = parseSkill("---\nalways: true\n---\n# X\nplan notu\n## Midscene\n- Giriş Hesabım menüsünde.\n### alt\n- ek\n## Sonra\nbaşka", "x");
  assert.equal(midsceneNotes(skill), "- Giriş Hesabım menüsünde.\n### alt\n- ek");
  assert.equal(midsceneNotes(parseSkill("---\nalways: true\n---\nbölümsüz", "y")), "");
  assert.equal(midsceneContext([skill]), "Test ortamı notları (bir QA uzmanından):\n- Giriş Hesabım menüsünde.\n### alt\n- ek");
  assert.equal(midsceneContext([skill], 5), "", "sınırı aşan not eklenmez");

  const skills = loadSkills([builtinDir]);
  const text = caseSkillText({ title: "C101 Geçerli test kullanıcısıyla giriş", tags: ["smoke"], steps: [{ text: "Giriş yap butonu" }] });
  const context = midsceneContext(selectSkills(skills, [text]));
  assert.match(context, /çerez, bildirim/, "çekirdeğin notu her zaman gelir");
  assert.match(context, /Google, Apple veya Facebook/, "giriş case'i giriş becerisinin notunu alır");
  assert.ok(context.length <= 2_100);
});
