#!/usr/bin/env python3
"""把 Edge Functions 连同 _shared 依赖合并成单文件（Supabase 控制台粘贴用）。
用法: python3 bundle.py  → 输出到 platform/supabase/bundled/<fn>.ts
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # platform/supabase
FUNCS = ["api-auth", "api-posts", "api-scenes", "api-reply", "crawl-tick", "health-digest"]
OUT = ROOT / "bundled"
if not OUT.exists():
    OUT.mkdir()

IMPORT_RE = re.compile(r'^import\s+(?:type\s+)?\{[^}]*\}\s+from\s+"([^"]+)";?\s*$', re.M)

def resolve(from_file: Path, spec: str) -> Path:
    """相对路径解析到绝对文件路径"""
    if not spec.startswith("."):
        return None  # 外部依赖 (esm.sh / npm:) 保留
    p = (from_file.parent / spec).resolve()
    return p if p.exists() else None

def collect(file: Path, seen: dict, order: list):
    """递归收集相对依赖，拓扑顺序（被依赖者在前）"""
    src = file.read_text(encoding="utf-8")
    for m in IMPORT_RE.finditer(src):
        dep = resolve(file, m.group(1))
        if dep and dep not in seen:
            seen[dep] = True
            collect(dep, seen, order)  # 先递归其依赖
            if dep not in order:
                order.append(dep)

def strip_relative_imports(src: str, file: Path) -> tuple[str, list[str]]:
    """移除相对 import 行；返回 (处理后的源码, 保留的外部 import 行)"""
    external = []
    def repl(m):
        spec = m.group(1)
        if spec.startswith("."):
            return ""  # 相对依赖已内联
        external.append(m.group(0))
        return m.group(0)
    out = IMPORT_RE.sub(repl, src)
    return out, external

for fn in FUNCS:
    entry = ROOT / "functions" / fn / "index.ts"
    seen, order = {}, []
    collect(entry, seen, order)
    # order: 依赖拓扑序（glue/logic 在前）

    pieces = []
    all_external = []
    for dep in order:
        src = dep.read_text(encoding="utf-8")
        # 所有 import 行全部摘除（相对依赖已内联，外部依赖统一置顶聚合）
        ext = []
        def harvest(m):
            if not m.group(1).startswith("."):
                ext.append(m.group(0))
            return ""
        src = IMPORT_RE.sub(harvest, src)
        all_external.extend(ext)
        pieces.append(f"// ---------- 内联自 {dep.relative_to(ROOT)} ----------\n{src.strip()}\n")

    main_src = entry.read_text(encoding="utf-8")
    main_ext = []
    def harvest_main(m):
        if not m.group(1).startswith("."):
            main_ext.append(m.group(0))
        return ""
    main_src = IMPORT_RE.sub(harvest_main, main_src)
    all_external.extend(main_ext)

    # 外部 import 去重置顶（保持完整 URL 形式，管理 API body 方式不支持 jsr:/npm: 短标识符）
    seen_ext, ext_lines = set(), []
    for e in all_external:
        if e not in seen_ext:
            seen_ext.add(e)
            ext_lines.append(e)

    bundle = "\n".join(ext_lines) + "\n\n" + "\n".join(pieces) + "\n// ---------- 函数主体 ----------\n" + main_src.strip() + "\n"
    (OUT / f"{fn}.ts").write_text(bundle, encoding="utf-8")
    deps = [d.relative_to(ROOT).as_posix() for d in order]
    print(f"✓ {fn}.ts  ({len(order)} 个内联依赖: {', '.join(deps)})")

print(f"\n输出目录: {OUT}")
