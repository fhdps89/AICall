import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

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
];

/**
 * 허용 목록 (오탐 방지용, 이유 필수):
 */
const ALLOWLIST: Array<{ file: string; textContains: string; reason: string }> = [
  {
    file: "src/ui/settings/SettingsModal.tsx",
    textContains: "Part B-1 고정 모델 구성",
    reason: "SettingsModal 303행(activeTab === 'models' && !devMode ? null)과 163행 탭 버튼에서 devMode=false 시 이미 차단됨",
  },
  {
    file: "src/ui/settings/SettingsModal.tsx",
    textContains: "gemini-3.5-transcribe VERBATIM (B-3)",
    reason: "SettingsModal 303행(activeTab === 'models' && !devMode ? null)과 163행 탭 버튼에서 devMode=false 시 이미 차단됨",
  },
  {
    file: "src/ui/settings/SettingsModal.tsx",
    textContains: "보안 및 허용 계정 (B-1)",
    reason: "SettingsModal 303행(activeTab === 'models' && !devMode ? null)과 163행 탭 버튼에서 devMode=false 시 이미 차단됨",
  },
];

function collectTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsxFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".tsx")) out.push(full);
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

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return (
    (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) ||
    (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node)
  );
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
  const code = sourceCode ?? fs.readFileSync(filePath, "utf-8");
  const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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

    if (!inDevMode) {
      if (
        ts.isJsxText(node) ||
        (ts.isStringLiteral(node) && !isModuleSpecifier(node)) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        checkText(node, node.text);
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      visit(node.left, inDevMode);
      const rightInDev = inDevMode || hasPositiveDevMode(node.left);
      visit(node.right, rightInDev);
      return;
    }

    if (ts.isConditionalExpression(node)) {
      visit(node.condition, inDevMode);
      const trueInDev = inDevMode || hasPositiveDevMode(node.condition);
      visit(node.whenTrue, trueInDev);
      visit(node.whenFalse, inDevMode);
      return;
    }

    if (ts.isIfStatement(node)) {
      visit(node.expression, inDevMode);
      const thenInDev = inDevMode || hasPositiveDevMode(node.expression);
      visit(node.thenStatement, thenInDev);
      if (node.elseStatement) visit(node.elseStatement, inDevMode);
      return;
    }

    ts.forEachChild(node, (child) => visit(child, inDevMode));
  }

  visit(sf, false);
  return violations;
}

test("src/ui/**/*.tsx does not expose internal terms outside devMode conditions", () => {
  const files = collectTsxFiles(uiDir);
  assert.ok(files.length > 0, "src/ui should contain .tsx files");

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
});
