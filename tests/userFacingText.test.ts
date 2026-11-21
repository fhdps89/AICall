import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { LIVE_STATUS_TEXT } from "../src/services/providers/liveStatusText.ts";
import { ADVANCED_TOGGLE_TEXT, KEY_TAB_LABEL } from "../src/ui/settings/settingsText.ts";
import { friendlyReviewError } from "../src/ui/review/reviewErrorText.ts";
import { friendlyError } from "../src/ui/common/friendlyError.ts";
import { NO_KEY_MESSAGE } from "../server/errors.ts";

const rootDir = path.resolve(import.meta.dirname, "..");
const uiDir = path.join(rootDir, "src/ui");

const FORBIDDEN_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "B-<digit>", regex: /\bB-\d+\b/ },
  { label: "src/config", regex: /\bsrc\/config\b/ },
  { label: "PRICING_RATES", regex: /\bPRICING_RATES\b/ },
  { label: "IndexedDB", regex: /\bIndexedDB\b/ },
  { label: "Cloud Storage", regex: /\bCloud Storage\b/ },
  { label: "Firestore", regex: /\bFirestore\b/ },
  { label: "컬렉션", regex: /컬렉션/ },
  { label: "Gemini", regex: /\bGemini\b/ },
  { label: "Live", regex: /\bLive\b/ },
  { label: "서버 중계", regex: /서버 중계/ },
  { label: "직접 연결", regex: /직접 연결/ },
  { label: "프롬프트", regex: /프롬프트/ },
  { label: "그록봇|Grok", regex: /그록봇|Grok/ },
  { label: "토큰", regex: /토큰/ },
  { label: "TTS", regex: /\bTTS\b/ },
  { label: "Survey topics", regex: /Survey topics/ },
  { label: "My role in", regex: /My role in/ },
  { label: "전사", regex: /전사/ },
  { label: "개발자", regex: /개발자/ },
  { label: "JSON", regex: /\bJSON\b/ },
];

/**
 * 개발자 전용 파일 목록 (이유 필수):
 */
const DEV_ONLY_FILES: Array<{ file: string; reason: string }> = [
  {
    file: "src/ui/settings/GeminiKeyPanel.tsx",
    reason: 'SettingsModal의 devOnly 탭 geminiKey에서만, 그리고 activeTab === "geminiKey" 분기의 devMode ? 조건 안에서만 렌더링된다',
  },
];

/**
 * 허용 목록 (오탐 방지용, 이유 필수):
 */
const ALLOWLIST: Array<{ file: string; textContains: string; reason: string }> = [];

function collectUiFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectUiFiles(full));
    else if (
      entry.isFile() &&
      (entry.name.endsWith(".tsx") || (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")))
    ) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * 조건식 안에 부정(!devMode)이 아닌 긍정 devMode 식별자가 포함되어 있는지 판별한다.
 * 예: `devMode`, `devMode && timing`, `activeTab === "models" && devMode` -> true
 *     `!devMode`, `activeTab === "models" && !devMode` -> false
 */
function hasPositiveDevMode(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) {
    return expr.text === "devMode";
  }
  if (ts.isParenthesizedExpression(expr)) {
    return hasPositiveDevMode(expr.expression);
  }
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    return false;
  }
  if (ts.isBinaryExpression(expr)) {
    if (expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return hasPositiveDevMode(expr.left) || hasPositiveDevMode(expr.right);
    }
    return false;
  }
  return false;
}

function hasDevOnlyTrue(node: ts.ObjectLiteralExpression): boolean {
  return node.properties.some(
    (prop) =>
      ts.isPropertyAssignment(prop) &&
      ((ts.isIdentifier(prop.name) && prop.name.text === "devOnly") ||
        (ts.isStringLiteral(prop.name) && prop.name.text === "devOnly")) &&
      prop.initializer.kind === ts.SyntaxKind.TrueKeyword
  );
}

function isConsoleCall(node: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "console"
  );
}

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return (
    (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) ||
    (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node)
  );
}

function getCalleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function isTextLiteralNode(
  node: ts.Node
): node is
  | ts.StringLiteral
  | ts.NoSubstitutionTemplateLiteral
  | ts.TemplateHead
  | ts.TemplateMiddle
  | ts.TemplateTail {
  return (
    (ts.isStringLiteral(node) && !isModuleSpecifier(node)) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

function findForbiddenTerms(text: string): string[] {
  return FORBIDDEN_PATTERNS.filter(({ regex }) => regex.test(text)).map(({ label }) => label);
}

interface Violation {
  file: string;
  line: number;
  pattern: string;
  text: string;
}

function scanFile(filePath: string, sourceCode?: string): Violation[] {
  const relFile = path.isAbsolute(filePath)
    ? path.relative(rootDir, filePath).replace(/\\/g, "/")
    : filePath.replace(/\\/g, "/");
  if (DEV_ONLY_FILES.some((entry) => entry.file === relFile)) {
    return [];
  }

  const code = sourceCode ?? fs.readFileSync(filePath, "utf-8");
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, scriptKind);
  const violations: Violation[] = [];

  const checkText = (node: ts.Node, rawText: string) => {
    const text = rawText.trim();
    if (!text) return;
    for (const { label, regex } of FORBIDDEN_PATTERNS) {
      if (!regex.test(text)) continue;
      const allowed = ALLOWLIST.some((a) => a.file === relFile && text.includes(a.textContains));
      if (allowed) continue;
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      violations.push({
        file: relFile,
        line: line + 1,
        pattern: label,
        text: text.length > 80 ? `${text.slice(0, 77)}...` : text,
      });
    }
  };

  function visit(node: ts.Node, inDevMode: boolean): void {
    // JSX 주석 `{/* ... */}` 등 빈 JSX 표현식은 건너뜀
    if (ts.isJsxExpression(node) && !node.expression) {
      return;
    }

    // console.*(...) 호출 인자는 개발자 로그이므로 건너뜀
    if (ts.isCallExpression(node) && isConsoleCall(node)) {
      return;
    }

    const nextInDevMode =
      inDevMode || (ts.isObjectLiteralExpression(node) && hasDevOnlyTrue(node));

    if (!nextInDevMode) {
      if (ts.isJsxText(node) || isTextLiteralNode(node)) {
        checkText(node, node.text);
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      visit(node.left, nextInDevMode);
      const rightInDev = nextInDevMode || hasPositiveDevMode(node.left);
      visit(node.right, rightInDev);
      return;
    }

    if (ts.isConditionalExpression(node)) {
      visit(node.condition, nextInDevMode);
      const trueInDev = nextInDevMode || hasPositiveDevMode(node.condition);
      visit(node.whenTrue, trueInDev);
      visit(node.whenFalse, nextInDevMode);
      return;
    }

    if (ts.isIfStatement(node)) {
      visit(node.expression, nextInDevMode);
      const thenInDev = nextInDevMode || hasPositiveDevMode(node.expression);
      visit(node.thenStatement, thenInDev);
      if (node.elseStatement) visit(node.elseStatement, nextInDevMode);
      return;
    }

    ts.forEachChild(node, (child) => visit(child, nextInDevMode));
  }

  visit(sf, false);
  return violations;
}

interface SinkCounts {
  onStatusChange: number;
  onMicWarning: number;
  fail: number;
  apiError: number;
  userMessage: number;
}

function scanSinks(
  filePath: string,
  sourceCode?: string
): { violations: Violation[]; counts: SinkCounts } {
  const relFile = path.isAbsolute(filePath)
    ? path.relative(rootDir, filePath).replace(/\\/g, "/")
    : filePath.replace(/\\/g, "/");
  const code = sourceCode ?? fs.readFileSync(filePath, "utf-8");
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, scriptKind);
  const violations: Violation[] = [];
  const counts: SinkCounts = {
    onStatusChange: 0,
    onMicWarning: 0,
    fail: 0,
    apiError: 0,
    userMessage: 0,
  };

  const scanSinkExpr = (expr: ts.Node) => {
    if (isTextLiteralNode(expr)) {
      const text = expr.text.trim();
      if (text) {
        for (const label of findForbiddenTerms(text)) {
          const { line } = sf.getLineAndCharacterOfPosition(expr.getStart(sf));
          violations.push({
            file: relFile,
            line: line + 1,
            pattern: label,
            text: text.length > 80 ? `${text.slice(0, 77)}...` : text,
          });
        }
      }
    }
    ts.forEachChild(expr, scanSinkExpr);
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = getCalleeName(node.expression);
      if (callee === "onStatusChange") {
        counts.onStatusChange++;
        if (node.arguments[1]) scanSinkExpr(node.arguments[1]);
      } else if (callee === "onMicWarning") {
        counts.onMicWarning++;
        if (node.arguments[0]) scanSinkExpr(node.arguments[0]);
      } else if (callee === "fail") {
        counts.fail++;
        if (node.arguments[1]) scanSinkExpr(node.arguments[1]);
      } else if (callee === "apiError") {
        counts.apiError++;
        if (node.arguments[3]) scanSinkExpr(node.arguments[3]);
      }
    } else if (ts.isPropertyAssignment(node)) {
      const propName =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
      if (propName === "userMessage") {
        counts.userMessage++;
        scanSinkExpr(node.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return { violations, counts };
}

test("src/ui/**/*.{ts,tsx} does not expose internal terms outside devMode conditions", () => {
  const files = [
    ...collectUiFiles(uiDir),
    path.join(rootDir, "src/services/providers/liveStatusText.ts"),
  ];
  assert.ok(files.length > 0, "src/ui should contain .ts/.tsx files");

  const allViolations = files.flatMap((file) => scanFile(file));
  assert.deepEqual(
    allViolations,
    [],
    `Found internal terms outside devMode:\n${allViolations
      .map((v) => `  - ${v.file}:${v.line} [${v.pattern}] "${v.text}"`)
      .join("\n")}`
  );
});

test("scanFile detects forbidden terms outside devMode and allows inside positive devMode", () => {
  const exposed = scanFile(
    "virtual/exposed.tsx",
    `export const C = () => <div>Firestore에 저장됨</div>;`
  );
  assert.equal(exposed.length, 1);
  assert.equal(exposed[0].pattern, "Firestore");

  const guarded = scanFile(
    "virtual/guarded.tsx",
    `export const C = ({ devMode }: { devMode: boolean }) => <div>{devMode && <span>Firestore · IndexedDB</span>}</div>;`
  );
  assert.deepEqual(guarded, []);

  const negated = scanFile(
    "virtual/negated.tsx",
    `export const C = ({ devMode }: { devMode: boolean }) => <div>{!devMode && <span>Firestore</span>}</div>;`
  );
  assert.equal(negated.length, 1);
  assert.equal(negated[0].pattern, "Firestore");

  const devOnlyTab = scanFile(
    "virtual/devOnlyTab.ts",
    `export const T = { label: "Gemini 키", devOnly: true };`
  );
  assert.deepEqual(devOnlyTab, []);

  const nonDevOnlyTab = scanFile(
    "virtual/nonDevOnlyTab.ts",
    `export const T = { label: "Gemini 키" };`
  );
  assert.equal(nonDevOnlyTab.length, 1);
  assert.equal(nonDevOnlyTab[0].pattern, "Gemini");

  const consoleIgnored = scanFile(
    "virtual/console.tsx",
    `export const log = () => { console.log("Gemini Live"); };`
  );
  assert.deepEqual(consoleIgnored, []);

  const tsViolating = scanFile(
    "virtual/helper.ts",
    `export const label = "TTS 글자 수";`
  );
  assert.equal(tsViolating.length, 1);
  assert.equal(tsViolating[0].pattern, "TTS");
});

test("user-facing text sinks in provider and server carry no internal terms", () => {
  const providerFile = path.join(rootDir, "src/services/providers/geminiLiveProvider.ts");
  const serverFile = path.join(rootDir, "server.ts");
  const serverSubFiles = fs
    .readdirSync(path.join(rootDir, "server"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(rootDir, "server", entry.name))
    .sort();

  const providerResult = scanSinks(providerFile);
  const serverResult = scanSinks(serverFile);
  const subResults = serverSubFiles.map((f) => scanSinks(f));

  assert.ok(
    providerResult.counts.onStatusChange >= 6,
    `Expected at least 6 onStatusChange calls in geminiLiveProvider.ts, got ${providerResult.counts.onStatusChange}`
  );
  assert.ok(
    serverResult.counts.userMessage >= 1,
    `Expected at least 1 userMessage property in server.ts, got ${serverResult.counts.userMessage}`
  );

  const allViolations = [
    ...providerResult.violations,
    ...serverResult.violations,
    ...subResults.flatMap((r) => r.violations),
  ];
  assert.deepEqual(
    allViolations,
    [],
    `Found internal terms in user-facing sinks:\n${allViolations
      .map((v) => `  - ${v.file}:${v.line} [${v.pattern}] "${v.text}"`)
      .join("\n")}`
  );
});

test("provider connecting/connected statuses use LIVE_STATUS_TEXT", () => {
  const providerFile = path.join(rootDir, "src/services/providers/geminiLiveProvider.ts");
  const code = fs.readFileSync(providerFile, "utf-8");
  const sf = ts.createSourceFile(providerFile, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const calls: Array<{ status: string; arg: ts.Expression | undefined; line: number }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && getCalleeName(node.expression) === "onStatusChange") {
      const first = node.arguments[0];
      if (first && ts.isStringLiteral(first) && (first.text === "connecting" || first.text === "connected")) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        calls.push({ status: first.text, arg: node.arguments[1], line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  assert.equal(calls.length, 6, `Expected 6 connecting/connected onStatusChange calls, got ${calls.length}`);
  for (const call of calls) {
    assert.ok(
      call.arg &&
        ts.isPropertyAccessExpression(call.arg) &&
        ts.isIdentifier(call.arg.expression) &&
        call.arg.expression.text === "LIVE_STATUS_TEXT",
      `Line ${call.line} (${call.status}) should pass LIVE_STATUS_TEXT.*`
    );
  }
});

test("LIVE_STATUS_TEXT values are friendly and hide the connection path", () => {
  for (const [key, value] of Object.entries(LIVE_STATUS_TEXT)) {
    assert.ok(value.trim().length > 0, `LIVE_STATUS_TEXT.${key} must not be empty`);
    assert.deepEqual(
      findForbiddenTerms(value),
      [],
      `LIVE_STATUS_TEXT.${key} contains forbidden terms: ${value}`
    );
    assert.equal(
      /직접|중계|우회|서버/.test(value),
      false,
      `LIVE_STATUS_TEXT.${key} must not mention connection path: ${value}`
    );
  }
  assert.equal(LIVE_STATUS_TEXT.connecting, "튜터에게 연결하는 중...");
});

test("no-key guidance points to the real advanced toggle and key tab", () => {
  const reviewMsg = friendlyReviewError(NO_KEY_MESSAGE);

  for (const [name, msg] of [
    ["NO_KEY_MESSAGE", NO_KEY_MESSAGE],
    ["friendlyReviewError(NO_KEY_MESSAGE)", reviewMsg],
  ] as const) {
    assert.ok(
      msg.includes(ADVANCED_TOGGLE_TEXT.show),
      `${name} must include "${ADVANCED_TOGGLE_TEXT.show}"`
    );
    assert.ok(msg.includes(KEY_TAB_LABEL), `${name} must include "${KEY_TAB_LABEL}"`);
    assert.deepEqual(
      findForbiddenTerms(msg),
      [],
      `${name} must not contain forbidden terms: ${msg}`
    );
  }

  assert.equal(friendlyError(new Error(NO_KEY_MESSAGE)), NO_KEY_MESSAGE);
});

test("geminiKey settings tab is devOnly", () => {
  const settingsSrc = fs.readFileSync(
    path.join(rootDir, "src/ui/settings/SettingsModal.tsx"),
    "utf-8"
  );
  assert.match(settingsSrc, /id:\s*"geminiKey",\s*label:\s*KEY_TAB_LABEL,\s*devOnly:\s*true/);
  assert.match(settingsSrc, /activeTab === "geminiKey" \? \(\s*devMode \? <GeminiKeyPanel/);
});
