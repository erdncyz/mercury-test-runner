import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adfToText, confluenceConfigured, fetchJiraIssue, findReferences, gatherReferences, htmlToText, jiraConfigured, refersToIssue, testAtlassian, wikiToText,
} from "../src/atlassian.mjs";

const cloud = { jira_host: "https://firma.atlassian.net/", jira_user: "qa@example.com", jira_api_token: "jira-gizli" };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A small Jira + Confluence: PROJ-7 exists, links a Confluence page in its description and as a remote link.
function fakeAtlassian({ calls = [] } = {}) {
  return async (url, options) => {
    calls.push({ url, auth: options.headers.Authorization });
    const path = new URL(url).pathname;
    if (path.endsWith("/rest/api/2/issue/PROJ-7")) {
      return json({
        key: "PROJ-7",
        names: { customfield_100: "Acceptance Criteria", customfield_200: "Sprint" },
        fields: {
          summary: "Şifre sıfırlama",
          issuetype: { name: "Story" },
          status: { name: "In Test" },
          labels: ["web", "giris"],
          components: [{ name: "Hesap" }],
          description: "h2. Amaç\nKullanıcı şifresini *e-posta* ile sıfırlar.\nTasarım: [Analiz|https://firma.atlassian.net/wiki/spaces/QA/pages/12345/Analiz]\nOrtam: https://test.example.com",
          customfield_100: "# Geçerli e-posta ile bağlantı gönderilir\n# Kayıtsız e-posta için hata gösterilir",
          customfield_200: "Sprint 12",
          comment: { comments: [{ author: { displayName: "Ayşe" }, body: "Bağlantı 24 saat geçerli." }] },
          subtasks: [{ key: "PROJ-8", fields: { summary: "API" } }],
        },
      });
    }
    if (path.endsWith("/rest/api/2/issue/PROJ-7/remotelink")) return json([{ object: { url: "https://firma.atlassian.net/wiki/pages/viewpage.action?pageId=67890" } }]);
    if (path.endsWith("/rest/api/content/12345")) {
      return json({ id: "12345", title: "Analiz", space: { key: "QA" }, _links: { webui: "/spaces/QA/pages/12345" }, body: { storage: { value: "<h1>Kurallar</h1><ul><li>Bağlantı tek kullanımlık</li></ul><p>Şifre &amp; tekrar</p>" } } });
    }
    if (path.endsWith("/rest/api/content/67890")) return json({ message: "yok" }, 404);
    if (path.endsWith("/rest/api/2/myself")) return json({ displayName: "QA Bot" });
    if (path.endsWith("/rest/api/space")) return json({ results: [] });
    return json({ errorMessages: ["Issue does not exist"] }, 404);
  };
}

test("chat cümlesindeki Jira anahtarları ve bağlantıları, Confluence sayfaları bulunur", () => {
  const found = findReferences("PROJ-7 ve https://jira.example.com/browse/ABC-12 için test yaz, analiz: https://firma.atlassian.net/wiki/spaces/QA/pages/12345/Analiz ve https://wiki.example.com/pages/viewpage.action?pageId=999");
  assert.deepEqual(found.issues.sort(), ["ABC-12", "PROJ-7"]);
  assert.deepEqual(found.linked, ["ABC-12"]);
  assert.deepEqual(found.pages, ["12345", "999"]);
  assert.deepEqual(findReferences("https://example.com/urun/ABC-12 sayfasını aç").issues, [], "başka sitenin adresindeki anahtar kayıt değildir");
  assert.deepEqual(findReferences("https://example.com/pages/12345 aç").pages, [], "Confluence olmayan /pages/ adresi sayfa değildir");
  assert.equal(refersToIssue("bu task için test case çıkart ve koş"), true);
  assert.equal(refersToIssue("story'yi test et"), true);
  assert.equal(refersToIssue("example.com'da UTF-8 ile kaydet"), false);
});

test("Jira wiki, ADF ve Confluence HTML düz metne çevrilir", () => {
  assert.equal(wikiToText("h2. Başlık\n* madde *kalın* [Bağlantı|https://example.com]"), "Başlık\n- madde kalın Bağlantı (https://example.com)");
  assert.equal(adfToText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Merhaba" }] }, { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "bir" }] }] }] }] }).trim(), "Merhaba\n- bir");
  assert.equal(htmlToText("<p>A &amp; B</p><ul><li>x</li></ul>"), "A & B\n\n- x");
});

test("Jira kaydı açıklama, kabul kriterleri, yorumlar ve bağlı Confluence sayfasıyla okunur", async () => {
  const calls = [];
  const { references, errors } = await gatherReferences(cloud, "PROJ-7 için test case çıkar ve koş", [], fakeAtlassian({ calls }));
  assert.deepEqual(errors, [], "yalnız kayıttan bağlanan sayfanın 404'ü sessiz geçer");
  assert.equal(references.length, 2);
  const [issue, page] = references;
  assert.equal(issue.key, "PROJ-7");
  assert.equal(issue.url, "https://firma.atlassian.net/browse/PROJ-7");
  assert.equal(issue.title, "Şifre sıfırlama");
  assert.match(issue.text, /Tür: Story/);
  assert.match(issue.text, /Açıklama:\nAmaç\nKullanıcı şifresini e-posta ile sıfırlar\./);
  assert.match(issue.text, /Acceptance Criteria:\n- Geçerli e-posta ile bağlantı gönderilir\n- Kayıtsız e-posta için hata gösterilir/);
  assert.doesNotMatch(issue.text, /Sprint 12/, "ilgisiz özel alanlar modele gitmez");
  assert.match(issue.text, /Ayşe: Bağlantı 24 saat geçerli\./);
  assert.match(issue.text, /PROJ-8 API/);
  assert.equal(page.kind, "confluence");
  assert.equal(page.url, "https://firma.atlassian.net/wiki/spaces/QA/pages/12345");
  assert.match(page.text, /Kurallar\n+- Bağlantı tek kullanımlık\n+Şifre & tekrar/);
  assert.ok(calls.every((call) => call.auth === `Basic ${Buffer.from("qa@example.com:jira-gizli").toString("base64")}`), "Cloud: e-posta + token");
  assert.ok(calls.some((call) => call.url.startsWith("https://firma.atlassian.net/wiki/rest/api/content/12345")), "Confluence adresi Cloud'da <jira>/wiki");
});

test("'bu task' önceki mesajdaki kaydı kullanır; hatalar ve eksik ayar açıkça döner", async () => {
  const fetchImpl = fakeAtlassian();
  const fromEarlier = await gatherReferences(cloud, "bu task için test case çıkart ve koş", ["merhaba", "PROJ-7'ye bakar mısın"], fetchImpl);
  assert.equal(fromEarlier.references[0].key, "PROJ-7");

  const quiet = await gatherReferences(cloud, "example.com'da UTF-8 ile kaydet", [], fetchImpl);
  assert.deepEqual(quiet, { references: [], errors: [] }, "görev denmeyen ve Jira'da olmayan anahtar sessizce yok sayılır");

  const missing = await gatherReferences(cloud, "PROJ-99 task'ını test et", [], fetchImpl);
  assert.deepEqual(missing.errors, ["PROJ-99: Jira'da bu kayıt yok ya da hesabın erişimi yok (404)"]);

  const denied = await gatherReferences(cloud, "https://firma.atlassian.net/browse/PROJ-7", [], async () => json({}, 401));
  assert.match(denied.errors[0], /^PROJ-7: Jira kimlik bilgilerini reddetti \(401\)/);

  const html = await gatherReferences(cloud, "PROJ-7 task", [], async () => new Response("<html>SSO</html>", { status: 200 }));
  assert.match(html.errors[0], /Jira yanıtı JSON değil/, "SSO giriş sayfası sessizce kabul edilmez");

  const unset = await gatherReferences({}, "PROJ-7 task'ı için test yaz", [], fetchImpl);
  assert.deepEqual(unset.errors, ["PROJ-7: Jira ayarı eksik (Ayarlar → Jira & Confluence)"]);
  assert.deepEqual(await gatherReferences({}, "UTF-8 ile kaydet", [], fetchImpl), { references: [], errors: [] }, "ayar yokken sıradan cümle etkilenmez");
});

test("Server/Data Center PAT ile Bearer kullanılır; Confluence kendi bilgileriyle ayrı kurulabilir", async () => {
  const server = { jira_host: "https://jira.example.com", jira_user: "", jira_api_token: "pat-jira", confluence_host: "https://wiki.example.com", confluence_user: "", confluence_api_token: "pat-wiki" };
  assert.equal(jiraConfigured(server), true);
  assert.equal(confluenceConfigured(server), true);
  assert.equal(confluenceConfigured({ jira_host: "https://jira.example.com", jira_api_token: "x" }), false, "Server'da Confluence adresi tahmin edilmez");
  const calls = [];
  await fetchJiraIssue(server, "PROJ-7", fakeAtlassian({ calls }));
  assert.equal(calls[0].auth, "Bearer pat-jira");
  const page = await gatherReferences(server, "https://wiki.example.com/pages/viewpage.action?pageId=12345", [], fakeAtlassian({ calls }));
  assert.equal(page.references[0].title, "Analiz");
  assert.equal(calls.at(-1).auth, "Bearer pat-wiki");
});

test("bağlantı testi Jira kullanıcısını ve Confluence erişimini söyler", async () => {
  assert.deepEqual(await testAtlassian({}), { skipped: true, reason: "Jira ayarı eksik" });
  assert.deepEqual(await testAtlassian(cloud, fakeAtlassian()), { ok: true, jiraUser: "QA Bot", confluence: "ok" });
  const noWiki = await testAtlassian({ ...cloud, jira_host: "https://jira.example.com" }, fakeAtlassian());
  assert.equal(noWiki.confluence, "missing");
});
