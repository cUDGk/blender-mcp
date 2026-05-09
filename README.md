<div align="center">

# blender-mcp

### Blender を永続ヘッドレス化する Model Context Protocol サーバー

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat&logo=typescript&logoColor=white)](src/index.ts)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?style=flat&logo=node.js&logoColor=white)](package.json)
[![Blender](https://img.shields.io/badge/Blender-4.2%2B-E87D0D?style=flat&logo=blender&logoColor=white)](https://www.blender.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF?style=flat)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat)](LICENSE)

**LLM から Blender Python API を直接叩く。プロセス常駐で起動コスト 0。**

---

</div>

## 概要

`blender --background --python -c "..."` を毎回叩く素朴な MCP は、毎回数秒の起動コストを払うので実用にならない。このサーバーは Blender を**一度だけ起動し、ソケット経由で Python を送り込み続ける**事で、2回目以降の操作を体感ゼロで動かす。

| 要素 | 実装 |
|---|---|
| トランスポート | stdio MCP |
| 子プロセス | `blender --background --python blender/server.py` |
| 橋渡し | localhost TCP + 改行区切り JSON |
| スクリプト層 | TypeScript (MCP SDK) ↔ Python (`bpy`) |
| ライフサイクル | 初回ツール呼び出しで起動、MCP 終了で自動停止 |

## 特徴

| アクション | 用途 |
|---|---|
| `execute` | 任意の Python を Blender 内で実行。`_result = ...` で値を返す。stdout/stderr を捕捉 |
| `scene` | シーングラフを JSON でダンプ（オブジェクト・変形・マテリアル・メッシュ・コレクション） |
| `create` | プリミティブ追加（cube / sphere / ico_sphere / plane / cone / cylinder / torus / monkey / camera / light_* / empty） |
| `delete` | 名前でオブジェクト削除 |
| `transform` | location / rotation_euler (rad) / scale を設定 |
| `select` | 名前配列・all・none で選択状態を制御 |
| `material` | Principled BSDF マテリアルを作成/更新（color, metallic, roughness） |
| `render` | 現在のシーンをレンダリング（`CYCLES` / `BLENDER_EEVEE_NEXT` / `BLENDER_WORKBENCH`、解像度・サンプル数・カメラ・フレーム指定可） |
| `import_file` / `export_file` | `.obj` / `.fbx` / `.glb` / `.gltf` / `.stl` / `.ply`（`.dae` は import のみ） |
| `open` / `save` | `.blend` ファイルの読み込み / 保存 |
| `reset` | ファクトリリセット（空シーン） |
| `keyframe_insert` | 任意プロパティ (location / rotation_euler / scale / hide_* / 他 attr) にキーフレーム挿入。`value` で値を事前設定、`interpolation` で補間種別 (CONSTANT / LINEAR / BEZIER / SINE / QUAD / CUBIC / QUART / QUINT / EXPO / CIRC / BACK / BOUNCE / ELASTIC) 指定可 |
| `keyframe_delete` | 特定 `frame` またはプロパティ全体のキーフレーム削除 |
| `list_keyframes` | fcurves と各 keyframe_points (frame / value / interpolation) を列挙 |
| `set_frame` | シーン現在フレームを設定 |
| `frame_range` | `scene.frame_start` / `frame_end` / `render.fps` を一括設定 |
| `add_modifier` | BEVEL / SUBSURF / ARRAY / SOLIDIFY / MIRROR / BOOLEAN / DECIMATE / WAVE / ... を追加、`params` dict でアトリビュート設定、未知 params は `unknown_params` に収集して返却 |
| `remove_modifier` | `modifier_name` で削除 |
| `list_modifiers` | modifier 一覧 + 主要 attr (levels / render_levels / count / width / segments / thickness / factor / angle / axis / offset / operation / solver) を抽出 |
| `camera_look_at` | カメラに Track To constraint を張って target を見続けるように |

## 処理フロー

```mermaid
sequenceDiagram
    participant LLM
    participant MCP as blender-mcp (stdio)
    participant Bridge as Blender (background)

    LLM->>MCP: tool call (action=create, primitive=cube)
    Note over MCP,Bridge: 初回のみ Blender を spawn
    MCP->>Bridge: spawn blender --background --python server.py
    Bridge-->>MCP: stdout: BLENDER_MCP_READY
    MCP->>Bridge: TCP connect 127.0.0.1:54321
    MCP->>Bridge: {"id":1,"action":"create","params":{...}}\n
    Bridge->>Bridge: bpy.ops.mesh.primitive_cube_add()
    Bridge-->>MCP: {"id":1,"ok":true,"result":{...}}\n
    MCP-->>LLM: JSON text content
```

## インストール

```bash
git clone https://github.com/cUDGk/blender-mcp.git
cd blender-mcp
npm install
npm run build
```

Blender 4.2 以降が必要。インストール先は自動検出する（Windows の `C:\Program Files\Blender Foundation\Blender 4.x\blender.exe`、macOS の `/Applications/Blender.app`、Linux の `/usr/bin/blender` など）。見つからない場合は `BLENDER_PATH` 環境変数で明示する。

## 使い方

### Claude Code に登録

```bash
claude mcp add blender -- node C:/Users/user/Desktop/_MCP/blender-mcp/dist/index.js
```

### 設定可能な環境変数

| 変数 | デフォルト | 用途 |
|---|---|---|
| `BLENDER_PATH` | 自動検出 | blender 実行ファイルの絶対パス |
| `BLENDER_MCP_PORT` | `54321` | 橋渡し用の localhost TCP ポート |
| `BLENDER_STARTUP_TIMEOUT` | `60000` | Blender 起動タイムアウト (ms) |
| `BLENDER_REQUEST_TIMEOUT` | `120000` | 単一リクエストのタイムアウト (ms) |
| `BLENDER_MCP_WORKSPACE` | MCP サーバーの cwd（= 子プロセス Blender の cwd と同じ） | ファイル IO (render / import / export / open / save) を許可するルートディレクトリ。配下以外への書き込み・読み込みは拒否される |
| `BLENDER_MCP_ALLOW_EXECUTE` | 未設定 | `1` を設定した場合のみ `execute` アクション (任意 Python 実行) を有効化。RCE リスクがあるため明示的なオプトインを要求 |
| `BLENDER_MCP_DEBUG` | 未設定 | `1` でエラー応答に Python トレースバックを含める (ホストパスが漏れるため通常はオフ) |
| `BLENDER_MCP_TOKEN` | 自動生成 (32 byte hex) | Bridge が起動毎に乱数生成して Blender 側に env で渡すワンタイム共有秘密。**手動で設定しないこと** — 設定すると Bridge ↔ Blender 間で値がずれて auth エラーになる |

セキュリティ:

- ループバック TCP ソケットはローカルプロセスから誰でも到達可能なので、**毎起動ごとに乱数トークン**を Bridge → Blender に env で渡し、リクエストごとに突き合わせている。トークンが無いと `auth` エラーで拒否される。
- `--disable-autoexec` + `wm.open_mainfile(use_scripts=False)` で、悪意ある `.blend` の自動実行 Python による RCE を遮断する。
- ファイル IO 系アクションは `BLENDER_MCP_WORKSPACE` 配下に限定（path traversal 防止）。
- `execute` (任意 Python) は既定では無効。`BLENDER_MCP_ALLOW_EXECUTE=1` を明示する事で初めて有効化する。

### 呼び出し例

シーン確認 → キューブ追加 → マテリアル設定 → レンダリング:

> `output_path` はデフォルトで `BLENDER_MCP_WORKSPACE`（= 起動時の cwd）配下のみ許可される。workspace 外のパスは拒否されるので、`BLENDER_MCP_WORKSPACE` を適切に設定するか、workspace 配下のパスを使う事。

```json
{"action": "scene"}
{"action": "create", "primitive": "cube", "name": "Hero", "location": [0, 0, 1]}
{"action": "material", "object": "Hero", "color": [0.8, 0.2, 0.2], "metallic": 0.3, "roughness": 0.4}
{"action": "render", "output_path": "/your/workspace/out.png", "resolution_x": 1920, "resolution_y": 1080, "samples": 64, "engine": "CYCLES"}
```

キーフレームアニメーション (1 秒で真上に 5m 上昇):

```json
{"action": "frame_range", "start": 1, "end": 24, "fps": 24}
{"action": "keyframe_insert", "object": "A", "property": "location",
 "frame": 1, "value": [0, 0, 0]}
{"action": "keyframe_insert", "object": "A", "property": "location",
 "frame": 24, "value": [0, 0, 5], "interpolation": "LINEAR"}
```

モディファイア追加 (SUBSURF レベル 2 + BEVEL 幅 0.1):

```json
{"action": "add_modifier", "object": "A", "modifier_type": "SUBSURF",
 "params": {"levels": 2, "render_levels": 3}}
{"action": "add_modifier", "object": "A", "modifier_type": "BEVEL",
 "name": "edge_bevel", "params": {"width": 0.1, "segments": 3}}
```

カメラを追従ターゲットに向ける (Track To constraint):

```json
{"action": "camera_look_at", "camera": "Cam", "target": "Suzanne"}
```

宣言的アクションでカバーできない操作は `execute` に落とす:

```json
{
  "action": "execute",
  "code": "import bpy\nfor o in bpy.data.objects:\n    if o.type == 'MESH':\n        o.scale = (2, 2, 2)\n_result = len(bpy.data.objects)"
}
```

## 設計メモ

- **永続プロセス**が本 MCP の価値。素朴な `blender --python-expr` ラッパーが数秒×呼び出し回数の税金を払うのに対し、こちらは初回起動後ほぼゼロ。
- **単一ツール + `action` 振り分け**で MCP クライアントのコンテキスト消費を抑える（ツール定義は 1 枚）。
- **`execute` はエスケープハッチ**。宣言的アクションで綺麗に表現できる操作だけ個別化し、それ以外は `bpy` を直接叩かせる方針。
- **`--background` モード**で動かす為、GUI オペレータ依存のコード（モーダルダイアログ等）は動かない。レンダリング・IO・メッシュ編集・モディファイアは問題なし。

## Attribution

- [Blender](https://www.blender.org/) © Blender Foundation（GPL）— 本 MCP はラッパーであり Blender 本体のライセンスに従う
- [Model Context Protocol](https://modelcontextprotocol.io/) — 仕様・SDK

## ライセンス

MIT License © 2026 cUDGk — 詳細は [LICENSE](LICENSE) を参照。

## v0.2.1 修正

Claude Code の LLM ツール呼び出しパスで、object / array 型の引数が JSON 文字列化された状態で届く事があるバグに対応。文字列で受け取っても `coerceObject()` ヘルパで解釈し直すようにし、zod schema は `z.union([<本来>, z.string()])` に緩和した。正常な object / array 経路は従来通り動作する。
