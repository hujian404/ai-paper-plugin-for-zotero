# AiPluginForZotero

Zotero 的右侧栏采用论文对话布局，上方显示多轮问答，下方输入问题，并可在发送按钮旁选择模型。点击“历史会话”可恢复问答，并联动打开对应论文。API、Skill 与阅读参数集中在 **设置 → AiPluginForZotero** 中配置。

界面使用 Zotero 原生主题的侧栏背景、文字、边框、强调色与字体，随浅色和深色主题切换。操作按钮的文字水平、垂直居中，设置页与侧栏共用按钮样式，历史会话采用原生列表风格。

macOS 版统一文库、阅读器和设置的外观。文库左侧采用内嵌导航面板，标签栏和搜索框使用圆角控件。PDF 阅读器的批注工具直接排列在原生顶栏上。主题沿用 Zotero 当前的浅色或深色外观及系统强调色。[Apple macOS 设计指南](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos)

用户提问采用靠右、随内容伸缩的淡蓝色气泡，长问题自动换行。回答以 Markdown 正文呈现，支持表格、列表、引用、代码和数学公式。论文标题与右侧的工作树、历史会话、新会话和收起侧栏图标排列在同一行。图标使用 Zotero 内置资源，悬停 0.5 秒后显示文字提示，也支持键盘聚焦。

底部采用包含输入文字和操作区的圆角输入框，点击左下方加号可直接选择文件。右下方的模型下拉框采用透明背景，宽度按选中的模型名称计算，与圆形发送／停止按钮保持 4 px 间距。生成任务可在后台运行，标题和历史列表中的绿点表示该会话正在生成回答。历史会话支持右键置顶和删除。

## 安装或升级

1. 在 Windows 上从 `windows` 分支构建 `.xpi` 安装包。[Windows 分支](https://github.com/hujian404/ai-paper-plugin-for-zotero/tree/windows) · [从源码构建](#从源码构建)
2. 在 Zotero 中打开 **工具 → 插件 → 右上角齿轮 → 从文件安装插件**，选择该文件。
3. 打开 **设置 → AiPluginForZotero**。macOS 的设置入口位于屏幕顶部的 Zotero 菜单，Windows/Linux 通常位于编辑菜单。

AiPluginForZotero 沿用旧版 AI论文插件的 Zotero 插件 ID。在原来的 Zotero 配置中从文件安装，可继续使用保存的 API、Magpie 模型、阅读设置和会话。从采用旧 Skill 集合的版本首次安装时，插件会备份旧 Skill，再启用《论文精读》。

Windows 分支使用 fork 的 GitHub 更新地址。发布包含 `updates.json` 的发行版后，Zotero 可通过 **工具 → 插件 → 齿轮 → 检查更新** 查询兼容版本。[Zotero 更新说明](https://www.zotero.org/support/kb/updates_not_detected)

设置页的 Base URL 和 API Key 输入框与各自标签同行，宽度随显示内容调整。「显示／隐藏」位于密钥框右侧。API 参数采用双列排列，同列标签居中对齐，两个控件等宽。论文内容范围与历史上下文字符上限各占半行，两框等宽。Skill 的「新建」「导入」「删除」紧跟选择框，分别使用绿色、金黄色和红色底配白字，名称输入位于同行右侧。空间较窄时字段组按可用宽度换行。长名称可悬停查看完整文字。

## 使用前的设置

### API 配置

#### 直接配置

1. 在 **设置 → AiPluginForZotero → API 配置** 选中 **直接配置**，填写模型服务商的地址与 API Key。
2. 点击 **获取模型列表**。成功后自动保存当前 API 配置和模型列表，并同步到右侧栏。
3. 在 **默认模型** 下拉框选择模型，点击 **保存 API 配置**，再点击 **测试连接**。也可以直接在右侧栏选择模型，选择结果会自动保存。

支持采用 Bearer API Key 的 OpenAI 兼容 Chat Completions 接口，以及免鉴权的本地服务。模型发现需要服务提供兼容的 `GET /models` 接口，从响应的 `data[].id` 读取模型名称。[模型列表接口文档](https://developers.openai.com/api/reference/resources/models/methods/list)

| 配置 | 填写方法 |
| --- | --- |
| Base URL | 服务商提供的地址，如 `https://api.openai.com/v1` |
| 完整接口地址 | 也可填写以 `/chat/completions` 结尾的完整地址 |
| API Key | 服务商提供的密钥，本地免鉴权服务可留空 |
| 默认模型 | 点击“获取模型列表”后，从下拉框选择模型 |
| 论文字符上限 | 默认 60000，控制每次请求使用的论文文本长度 |
| 输出 token 上限 | 默认 4096，可按模型额度调整 |
| 输出长度参数 | 可选 `max_tokens`、`max_completion_tokens` 或服务端默认值 |
| Temperature | 留空时使用服务端默认值 |
| 请求超时 | 默认 180 秒 |

Base URL 自动补齐 `/chat/completions`。只填写域名时补齐 `/v1/chat/completions`。完整接口按填写的路径请求。

获取模型时使用同一路径前缀下的 `/models` 地址。例如 `https://api.example.com/v1` 对应 `https://api.example.com/v1/models`，完整 `/chat/completions` 地址也会转换为同前缀的 `/models`，保留查询参数。

模型列表会缓存在本机，重启后可继续选择。重新获取时，当前模型仍在返回列表中就继续保留，否则需要重新选择。列表使用服务实际返回的模型 ID，请选择支持 Chat Completions 的模型。

获取失败、返回空列表或响应格式无效时，设置页会显示错误，并保留之前保存的 API 配置和模型列表。获取期间修改地址或密钥会取消该次请求，随后可重新获取。

#### 通过 Magpie 配置

1. 打开本机 Magpie，配置供应商并启用要使用的对话模型。
2. 在 **设置 → AiPluginForZotero → API 配置** 选中 **通过 Magpie 配置**，点击 **从 Magpie 导入**。
3. 点击供应商行右侧的箭头展开。点击模型即可勾选或取消，勾选项带对号，并立即出现在提问框底部的模型菜单。首次导入后由你勾选模型，重新导入会保留目录中仍可用的已选项。

Magpie 在本机运行时，插件通过它的网关读取已启用的对话模型并发起问答。供应商凭据由 Magpie 管理。两种配置方式各自保存模型选择，论文字符上限和请求参数在直接配置表单中调整。[Magpie 网关文档](https://usemagpie.ai/docs/integrate)

### 论文问答设置

在设置页的 **论文问答** 区域选择内容范围，然后点击 **保存问答设置**。

- **优先 PDF，缺少时使用摘要** 会读取本地 PDF，缺少可用文本时使用条目摘要。
- **仅 PDF 全文** 使用本地 PDF 提取文本。云端附件需要先下载，扫描 PDF 需要先完成 OCR。
- **仅条目摘要** 使用当前条目的摘要字段。
- **历史上下文字符上限** 默认为 20000，控制每次请求携带的近期完整问答量。

长论文超过论文字符上限时，按约 75% 开头与 25% 结尾选取资料。完整会话和资料范围存储在本机历史记录中。

### Skill

首次安装或从旧版升级后，设置页的 **Skill** 区域只显示默认的《论文精读》。它使用随插件打包的 `addon/content/paper-reader.md`，用于整篇研读、针对性追问，以及按需核对作者资料和引用。

可以新建、编辑、删除 Skill，或导入 Markdown、TXT、JSON 文件。Markdown 的头部 `name` 字段用作名称，正文用作提示词。需要变更默认项时，勾选 **保存时设为默认 Skill**，再点击 **保存 Skill**。每次提问会使用当前选定的默认 Skill。

### 导入 API 与插件配置

在设置页 **导入与导出** 区域点击 **导入 API / 插件配置**。源码中的 `examples/api-config.json` 提供可编辑模板。

```json
{
  "baseURL": "https://api.example.com/v1",
  "apiKey": "替换为你的密钥",
  "maxTokens": 4096,
  "tokenParameter": "max_tokens",
  "contextChars": 60000,
  "timeoutSeconds": 180,
  "temperature": ""
}
```

导入上述模板后，点击 **获取模型列表**，再选择模型。配置文件也可携带 `model` 字段和 `models` 字符串数组，用于恢复已保存的模型选择与列表。

`base_url` 与 `api_key` 也可作为字段名。导入文件省略密钥时沿用当前密钥，空字符串会清除密钥。API Key 存放在 Zotero 凭据管理器中，导出配置包含 API 参数、模型列表、问答设置与 Skill。

## 论文问答

1. 在文库中选中论文，或在 Zotero 主窗口的标签页中打开 PDF。
2. 展开右侧栏，在底部下拉框选择模型，输入问题，例如“总结这篇论文”或“解释实验设计”。
3. 点击右下方的 **发送** 向上箭头，也可按 **Enter** 发送，**Shift+Enter** 换行。
4. 回答显示在上方，可以继续追问。每次请求包含当前论文资料与近期完整问答。
5. 生成时，发送箭头切换为 **停止生成** 方块图标，点击可取消正在查看的分支请求。回答下方有 **复制为 Markdown** 和 **从此处创建分支** 两个图标。右击回答正文可选择 **存为笔记**。

回答上方在生成期间展开显示论文读取、请求模型等实际步骤，以及服务流式返回的工作过程。生成完成后，过程自动收起为本轮耗时、总 Token 和缓存命中率，点击箭头可重新展开。缓存命中率是已命中的输入 Token 占全部输入 Token 的比例。服务缺少的用量数据以 `—` 显示。仅支持一次性响应的服务可在请求完成后查看其提供的工作过程和用量。[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)

鼠标停在提问气泡上时，气泡下方显示发送时间、复制和修改图标。键盘聚焦也可显示这些操作。修改后可点击 **重新发送**，或按 **Command+Enter**（Windows/Linux 为 **Ctrl+Enter**）。修改中间问题会在原会话中建立同级分支，修改首问会另开会话。原有问答可通过历史会话或工作树继续查看。

点击标题右侧的加号可为当前论文创建另一段问答。点击箭头收起侧栏，通过 Zotero 的侧栏切换按钮重新展开。

文库和 PDF 的右侧栏宽度以当前显示器可供窗口使用的横向空间为基准，最小为四分之一，最大为二分之一。可拖动侧栏左侧加粗至 6 px 的原生分隔条调整宽度。标题随可用空间伸缩，超出部分显示省略号，空间足够时显示完整标题。宽度基准使用 `Screen.availWidth`，按 CSS 像素计算。[屏幕可用宽度文档](https://developer.mozilla.org/en-US/docs/Web/API/Screen/availWidth)

正在生成的会话会在论文标题左侧显示绿点。打开历史、切换到其他会话、切换论文或新建会话时，已发出的请求继续在后台运行。返回原会话后可查看已生成的回答，也可以点击停止图标取消该会话。应用退出或插件停用时，进行中的请求会停止。

模型下拉框读取设置页已获取的模型列表。切换后，新问题使用所选模型，已有回答保留各自使用的模型记录。长模型名称会在控件内省略显示，悬停可查看完整名称。

### PDF 内容块快照和粘贴

1. 在 Zotero 的 PDF 阅读页按住 **Ctrl**（macOS 为 **⌘ Command**），将鼠标移到段落或插图上，等待蓝色框标出内容块。
2. 保持按住该键，点击蓝框内任意位置。插件会打开右侧问答栏，把框内画面添加到提问框内，并将光标移到输入区。独立阅读窗口中的快照会添加到主窗口里同一 PDF 的问答栏。
3. 也可以在提问框中按 **Ctrl+V**（macOS 为 **⌘V**）粘贴剪贴板中的文字和图片。文字插入光标处，图片显示为可移除的缩略图。每条问题可添加至多 4 张图片。
4. 发送截图或图片时，选择支持图像输入的 OpenAI 兼容 Chat Completions 模型。已发送的图片随问答保存在本机历史记录中，可从历史或工作树重新打开。追问时按当前分支携带近期图片，每次请求最多 4 张，优先携带本次提问的图片。[图像输入接口文档](https://developers.openai.com/api/docs/guides/images-vision?api-mode=chat)

快照、粘贴图片和从文件选择器添加的图片都在卡片上方显示缩略图，下方显示名称。点击卡片查看大图，点击右上角的叉号移除待发送图片。点开历史问答中的图片也可查看大图，按 **Esc** 或点关闭按钮返回对话。

选框取决于 PDF 自带的文本和图形结构。没有 OCR 文本层的扫描页可能只显示整页图像块。

### PDF 文字选择菜单

拖选 PDF 中的文字后，弹出菜单的上排用于选择批注颜色，下排三个按钮等宽排列。

- **高亮文本** 为选中文字绘制所选颜色的框线，保存为 Zotero 高亮批注。使用旧版画布渲染器时会使用 Zotero 的区域批注绘制方框。
- **下划线文本** 使用所选颜色添加 Zotero 下划线批注。
- **引用文本 @** 将文字放入一个以 `.md` 结尾的引用附件，加入当前论文的提问框。发送后，Markdown 引用会随问答一起保存。

### 添加文件

1. 点击输入框左下方的加号，直接打开文件选择窗口，可一次选择多个文件。鼠标悬停 0.5 秒显示“添加文件”提示。
2. 支持可提取文字的 PDF，UTF-8 编码的 TXT、Markdown、CSV、TSV、JSON 和 TeX 文件，以及 PNG、JPEG、WebP、GIF 和 BMP 图片。
3. 已选文件显示在输入框上方，点击文件旁的叉号可移除。输入问题后点击发送，可结合论文与补充文件提问。仅添加文件后直接发送时，默认要求模型结合当前论文分析文件。

文件在添加时提取文本，发送时按 **论文字符上限** 为本次补充文件分配文本额度，多个文件共享该额度。超出部分采用节选，节选信息随会话保存。扫描 PDF 需要先完成 OCR。

发送过的文件名与实际使用的节选文本保存在本机会话记录中，后续追问可在历史上下文额度内继续使用这些资料。

### Markdown 与数学公式

每次请求都会要求模型使用 Markdown，并沿用论文中的变量、大小写、希腊字母、上下标、向量、矩阵记号和公式编号。内置 Markdown 与 LaTeX 解析器，公式转换为 Zotero 浏览器内核支持的原生 MathML，在浅色和深色主题下使用当前文字颜色。渲染组件随 XPI 打包。[Markdown-it 文档](https://github.com/markdown-it/markdown-it)、[KaTeX 输出选项](https://katex.org/docs/options.html)

- 行内公式支持 `\(…\)` 与 `$…$`。
- 独立公式支持 `\[…\]`、`$$…$$` 与 `math` 代码块，支持分式、上下标、求和、矩阵、对齐公式及 `\tag{}` 编号。
- 过长的公式、表格和代码可在各自区域横向滚动。
- 复制回答会保留原始 Markdown 与 LaTeX。保存为笔记时，公式转换为 Zotero 原生的数学节点，并保留 LaTeX 源码。
- 公式语法无效或包含渲染器未支持的命令时，会保留公式源码，悬停可查看提示。

公式内容的准确性取决于 PDF 可提取文本与模型返回内容。PDF 缺失公式或符号有歧义时，提示词要求模型说明缺失，并请求用户补充公式或对应页面。

插件启用时，右侧的信息、摘要、附件、笔记等原生区块与导航由论文对话布局替换。布局覆盖 Zotero 主窗口的文库侧栏与 PDF 标签页右侧栏。

PDF 阅读页的顶栏隐藏“朗读”和“阅读模式”按钮。高亮、下划线、便签、文字、区域和手绘批注随颜色选择器排列在“外观”按钮左侧。停用插件即可恢复原有工具栏。

### 适合内容宽度

点击 PDF 顶栏绘图工具右边的双向箭头，按全篇最宽的可见内容缩放，并在两侧留约 8 像素的边距。各页使用相同的缩放比例，页内内容居中排列，阅读时只需纵向滚动。调整 Zotero 窗口大小、侧栏宽度或 PDF 方向后，会重新适配阅读区。再点一次可恢复原来的缩放、滚动及单双页布局。

首次开启时需要逐页分析 PDF 的文字、图片和图形。扫描件的纸张底色或印到页边的图形可能使显示范围接近整页宽度。

## 历史会话

点击标题右侧的 **历史会话** 文档图标，上方区域会显示按更新时间排列的全部会话。列表包含论文标题、首个问题和时间，再次点击该图标返回问答。

正在生成的会话在标题左侧显示绿点，完成后绿点消失。右击某条会话可选择 **置顶会话**、**取消置顶** 或红色的 **删除会话**。置顶记录优先排列，并显示原生图钉图标。删除会话会清除本机保存的问答与附件，删除生成中的会话会停止对应请求。

- 点击某个会话后，恢复该会话最近一次提问所在路径的问答内容。
- 对应本地 PDF 可用时，主页面会打开该 PDF 标签页。
- 对应论文只有条目资料时，主页面会定位到文库中的论文条目。
- 打开历史会话后可以继续提问。
- 论文已被删除或移入回收站时，可查看保存的问答，恢复论文后可继续关联操作。

历史记录位于当前 Zotero 配置目录的 `ai-paper/conversations/`。每个会话单独保存为 JSON，包含论文标识、问题、回答、分支关系、补充文件文本、图片、置顶状态、时间、模型、资料范围，以及本轮用量和工作过程。发送后自动保存，重启 Zotero 后可以继续打开。

点击发送会把论文资料、补充文件文本、图片、Skill、本次问题和选定的历史问答发送到设置中的 API。

## 分支与工作树

1. 点击某条回复下方的 **从此处创建分支**，对话回到该轮问答。发送新问题后，它会成为该问答的子节点。模型根据历史上下文字符上限读取这条路径上的问答。
2. 点击 **历史会话** 左侧的 **工作树** 按钮。当前论文的每个会话各有一棵树，连线表示追问关系。旧会话按原提问顺序显示为一条路径。
3. 点击任一节点可打开对应的问答路径并继续提问。每个节点用用户提问作标题，该标题最多显示 28 个字符（含省略号）。悬停可查看完整问题。

## 从源码构建

插件声明支持 Zotero 7–10。实际运行验证覆盖 macOS 上的 Zotero 10.0.9 和 Windows 上的 Zotero 10.0.8，范围见 `VERIFICATION.md`。Zotero 7–9 的运行验证仍待完成。

源码使用 Zotero 的 PreferencePanes、PDFWorker、Reader 和条目 API。对话布局挂载到主窗口的侧栏容器。阅读器通过 `renderToolbar` 事件加载工具栏样式。[Zotero 开发文档](https://www.zotero.org/support/dev/zotero_7_for_developers#custom_reader_event_handlers)、[Zotero 10 开发变更](https://www.zotero.org/support/dev/zotero_10_for_developers)

在仓库根目录运行以下命令。构建仅依赖 Python 3 标准库。第三方依赖、版本清单和对应许可证随仓库附带，可离线构建。

```sh
python3 build.py
```

生成的安装包位于 `dist/AiPluginForZotero-<版本>.xpi`。在 Windows PowerShell 下运行 `python build.py`，也可使用 `py -3 build.py`。

自动化逻辑与存储检查使用 Node.js 自带的测试运行器。

```sh
node --test tests/*.test.cjs
```

## 发布新版本

1. 在 `addon/manifest.json` 提高 `version`，提交并推送。继续使用相同的插件 ID 和 `update_url`。
2. 给该提交打对应的 `vX.Y.Z` 标签并推送。

   ```sh
   git tag v1.0.2
   git push origin v1.0.2
   ```

3. 在 fork 的 GitHub **Actions** 启用并检查 **Release Zotero plugin**。工作流会运行测试，以同一个版本构建 `.xpi` 和 `updates.json`，附齐文件后发布 Release。更新清单记录安装包的下载地址、SHA-256 和适用的 Zotero 版本。[Actions](https://github.com/hujian404/ai-paper-plugin-for-zotero/actions/workflows/release.yml) · [GitHub Releases](https://github.com/hujian404/ai-paper-plugin-for-zotero/releases)
4. 发布后打开更新清单，确认其中的版本号和下载链接。在装有该 fork 较早版本的 Zotero 中点 **检查更新**，确认插件升级到新版本。[更新清单](https://github.com/hujian404/ai-paper-plugin-for-zotero/releases/latest/download/updates.json)

## 源码结构

```text
addon/
  manifest.json
  bootstrap.js
  content/
    core.js             配置、请求上下文、响应与渲染入口
    paper-reader.md     内置《论文精读》提示词
    markdown.js         Markdown、LaTeX 与原生笔记公式转换
    vendor/             固定版本的解析组件与 MIT 许可证
    history.js          会话与分支存储、置顶删除、旧记录迁移
    layout.js           文库与阅读器侧栏布局及窗口生命周期
    macos.css           macOS 文库、阅读器、设置与 AI 侧栏外观
    reader-capture.js   PDF 内容块定位、悬停选框与快照
    reader-selection.js PDF 选中文字时的批注菜单、框线高亮与引用
    reader-fit.js       PDF 内容宽度测量和自动适配
    reader-toolbar.css  阅读器顶栏的批注工具与按钮布局
    runtime.js          Zotero 接口、论文导航、密钥、PDF 提取与请求
    sidebar.js          问答、分支工作树、文件输入与会话菜单
    sidebar.css
    native-ui.css       共享的原生主题按钮样式
    preferences.xhtml   独立设置页
    preferences.js
    preferences.css
examples/
tests/
build.py
```
