# GPT Skills

这里存放从 ChatGPT macOS 应用内置资源中拆解、提取出来的 skills，供本地阅读、对比和后续适配参考。

## 来源

提取自 ChatGPT 应用内的 `plugins/openai-bundled/plugins/` 资源。原始 skill 的版权归原作者/OpenAI 所有；其中 `hatch-pet/LICENSE.txt` 保留了原目录中的许可证。

这些内容不是 EH 自己编写的，也没有接入 EH 运行时。部分 skill 依赖 ChatGPT 宿主提供的能力（例如 `node_repl`、Computer History、Record & Replay、浏览器宿主 RPC），不能直接在本项目中独立运行。

## 内容

| 目录 | 用途 |
| --- | --- |
| `computer-history` | 查询用户近期活动记录 |
| `computer-use` | 通过 ChatGPT 的 Computer Use 操作本地 Mac 应用 |
| `control-chrome` | 控制用户已有的 Chrome 会话和标签页 |
| `control-in-app-browser` | 控制 ChatGPT 内置浏览器 |
| `deep-research` | 多轮检索并输出带引用的研究报告 |
| `hatch-pet` | 生成、修复、检查和打包动画宠物资源 |
| `image-guided-svg-3d` | 参考图片制作 SVG 插画、图标和 3D 资产 |
| `latex-compile` | 编译 LaTeX 项目 |
| `latex-doctor` | 检查 LaTeX/Tectonic/TeX Live 环境 |
| `onboard-new-user` | Codex 新用户引导流程（原 skill 名为 `setup-codex`） |
| `record-and-replay` | 录制 Mac 操作并转成可复用 skill |
| `texlive-runtime-installer` | 检测并按需安装 TeX Live |
| `visualize` | 在对话中创建可视化、交互工具和演示 |

## 使用边界

- 仅作参考，不代表 EH 已经具备对应工具。
- 不要把这里的宿主专用命令直接当成 EH 工具调用。
- 如果要移植某个 skill，需要先确认它依赖的宿主能力，并在 EH 里重新实现对应工具。
