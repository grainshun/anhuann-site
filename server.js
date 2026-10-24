/* =========================================================
 * Anhuann · 网站服务器（server.js）
 * ---------------------------------------------------------
 * 作用：把「静态个人站 + 可视化后台」跑成一个真正的动态网站。
 *
 * 特性：
 *   - 零第三方依赖，只用 Node 内置模块（http / fs / path / crypto）。
 *   - 对外提供前台静态页面，以及一组 JSON 接口让后台读/写内容。
 *   - 后台登录用「服务器端校验 + HttpOnly Cookie 会话」，比纯前端门禁安全。
 *   - 登录防爆破：同一 IP 连续失败多次会临时锁定。
 *   - 保存前自动备份 data.js（保留最近 5 份），后台可一键恢复。
 *
 * 启动：
 *   node server.js
 *   前台： http://localhost:8080/
 *   后台： http://localhost:8080/admin.html
 *
 * 可用环境变量（可选）：
 *   PORT          监听端口，默认 8080
 *   ADMIN_USER   后台账号，默认 AnHuann
 *   ADMIN_PASS   后台密码，必须来自环境变量或同目录 .env（不写进源码）
 *   GH_TOKEN     GitHub Token（repo 权限）：启用后后台保存会同步提交到仓库，避免动态平台磁盘临时导致内容丢失
 *   GH_OWNER     内容仓库所有者，默认 grainshun
 *   GH_REPO      内容所在仓库，默认 anhuann-site
 *   GH_BRANCH    分支，默认 main
 *   配置方式（任选其一）：
 *     - 在同目录建 .env 文件：ADMIN_PASS=你的密码   （推荐，.env 已被 .gitignore 忽略）
 *     - 或启动前设环境变量：set ADMIN_PASS=你的密码 （Windows）
 *   例：PORT=9000 ADMIN_USER=me ADMIN_PASS=secret node server.js
 *
 * 接口一览：
 *   GET  /api/content   公开：返回全部内容（前台动态读取用）
 *   POST /api/content   需登录：写入全部内容（后台保存用）
 *   POST /api/login     登录，成功下发会话 Cookie
 *   POST /api/logout    登出，清除会话
 *   GET  /api/session   登录态探测（200=已登录 / 401=未登录）
 *   GET  /api/backups   需登录：列出自动备份
 *   POST /api/restore   需登录：用某份备份覆盖当前内容
 * ========================================================= */

// 引入 Node 内置模块：HTTP 服务、文件系统、路径处理、加密（用于令牌与常量时间比较）
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ROOT：本文件所在目录，作为网站根目录（所有静态文件都相对它查找）
const ROOT = __dirname;

// 读取同目录下的 .env（若存在），把 ADMIN_PASS 等敏感配置从源码里挪开。
// 这样源码可以放心提交到 GitHub，而真实密码只留在本地 .env（已被 .gitignore 忽略）。
// 不引入 dotenv 依赖，用极简解析即可。
(function loadEnv() {
  try {
    const envPath = path.join(ROOT, ".env");
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, "utf8")
      .split("\n")
      .forEach((line) => {
        const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
      });
  } catch (e) {
    // .env 读取失败不影响启动，只是需要靠环境变量提供密码
  }
})();

// 监听端口：阿里云 FC 用 FC_SERVER_PORT，其次 PORT，否则 8080
const PORT = process.env.FC_SERVER_PORT || process.env.PORT || 8080;
// 后台账号：可经环境变量覆盖（用户名非机密，留默认值无妨）
const ADMIN_USER = process.env.ADMIN_USER || "AnHuann";
// 后台密码：必须来自环境变量或 .env，**不留明文默认值**，避免提交到仓库后泄露
const ADMIN_PASS = process.env.ADMIN_PASS;
// 内容根目录：默认用代码所在目录；在 FC 上可设 DATA_DIR 指向挂载的 NAS，
// 让 data.js 与备份在实例回收后依然保留（否则 FC 磁盘是临时的，编辑会丢失）
const DATA_DIR = process.env.DATA_DIR || ROOT;
// 内容源文件：前台与后台共享的 data.js 路径（服务器以它为唯一内容真相源）
const DATA_JS = path.join(DATA_DIR, "assets", "js", "data.js");
// 自动备份目录与保留份数
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const BACKUP_KEEP = 5;

// ---- GitHub 永久化 ----
// 在 Render / Railway 等动态平台上磁盘是临时的，后台保存只写本地会在重启/重新部署后丢失。
// 配置下面环境变量后，保存时会把最新 data.js 通过 GitHub API 提交回仓库，实现「永久保存」。
//   GH_TOKEN   必填：有 repo 权限的 GitHub Token（在平台环境变量里设置，勿写进源码）
//   GH_OWNER   可选：仓库所有者，默认 grainshun
//   GH_REPO    可选：内容所在仓库，默认 anhuann-site
//   GH_BRANCH  可选：分支，默认 main
const GH_TOKEN = process.env.GH_TOKEN;
const GH_OWNER = process.env.GH_OWNER || "grainshun";
const GH_REPO = process.env.GH_REPO || "anhuann-site";
const GH_BRANCH = process.env.GH_BRANCH || "main";
const GH_PATH = "assets/js/data.js";

/* 把最新 data.js 内容提交回 GitHub 仓库（覆盖式 PUT，需要现有文件 sha）。
 * 返回 Promise；网络/鉴权失败会 reject，由调用方做 best-effort 处理。 */
function commitToGitHub(contentUtf8) {
  return new Promise((resolve, reject) => {
    if (!GH_TOKEN) return reject(new Error("GH_TOKEN 未配置"));
    const auth = { Authorization: "Bearer " + GH_TOKEN, "User-Agent": "anhuann-server", Accept: "application/vnd.github+json" };
    const getReq = https.request(
      { hostname: "api.github.com", path: `/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}?ref=${GH_BRANCH}`, method: "GET", headers: auth },
      (ghRes) => {
        let buf = "";
        ghRes.on("data", (c) => (buf += c));
        ghRes.on("end", () => {
          if (ghRes.statusCode !== 200) return reject(new Error("获取 sha 失败 " + ghRes.statusCode));
          let sha;
          try { sha = JSON.parse(buf).sha; } catch (e) { return reject(e); }
          const putBody = JSON.stringify({ message: "content: update via admin", content: Buffer.from(contentUtf8, "utf8").toString("base64"), sha: sha, branch: GH_BRANCH });
          const putReq = https.request(
            { hostname: "api.github.com", path: `/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}`, method: "PUT", headers: Object.assign({}, auth, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(putBody) }) },
            (putRes) => {
              let pbuf = "";
              putRes.on("data", (c) => (pbuf += c));
              putRes.on("end", () => {
                if (putRes.statusCode >= 200 && putRes.statusCode < 300) resolve(true);
                else reject(new Error("提交失败 " + putRes.statusCode + " " + pbuf));
              });
            }
          );
          putReq.on("error", reject);
          putReq.write(putBody);
          putReq.end();
        });
      }
    );
    getReq.on("error", reject);
    getReq.end();
  });
}

/* =========================================================
 * 会话管理
 * 用内存中的 Map 保存 token -> { expiry }。
 * 注意：这是进程内会话，重启服务器会清空（对单人博客够用）；
 *       若要多进程/重启不失效，需要换成数据库或签名 Cookie。
 * ========================================================= */
const sessions = new Map();
const SESSION_TTL = 24 * 3600 * 1000;        // 普通会话有效期：1 天
const REMEMBER_TTL = 30 * 24 * 3600 * 1000;  // 勾选「记住我」后：30 天

/* =========================================================
 * 登录防爆破
 * 记录每个 IP 的连续失败次数，达到上限就锁定一段时间，
 * 防止有人反复试密码。锁定信息只在内存里，重启即清空。
 * ========================================================= */
const LOGIN_MAX = Number(process.env.LOGIN_MAX || 5);        // 连续失败次数上限
const LOGIN_LOCK_MS = Number(process.env.LOGIN_LOCK_MS || 10 * 60 * 1000); // 锁定时长（毫秒）
const loginFails = new Map();         // ip -> { count, until }

// 查询某 IP 还剩多少分钟锁定（0 表示未锁定）
function loginLockMinutes(ip) {
  const rec = loginFails.get(ip);
  if (rec && rec.until > Date.now()) {
    return Math.ceil((rec.until - Date.now()) / 60000);
  }
  return 0;
}
// 记录一次失败；达到上限则设置锁定时间并重新计数
function loginRecordFail(ip) {
  const now = Date.now();
  let rec = loginFails.get(ip);
  // 只有「曾被锁定且锁定已过期」才重新计数；普通失败要持续累加
  if (!rec || (rec.until > 0 && rec.until <= now)) rec = { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX) {
    rec.until = now + LOGIN_LOCK_MS;
    rec.count = 0; // 锁定后重新计数，解锁后有完整的 LOGIN_MAX 次机会
  }
  loginFails.set(ip, rec);
}

// 常见静态资源 MIME 类型表（用于响应头 Content-Type）
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/* =========================================================
 * 工具函数
 * ========================================================= */

/* 常量时间字符串比较：专门用于密码，避免「计时攻击」
 * （普通 === 会在第一个不同字符处提前返回，攻击者可借响应时间猜密码） */
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false; // 长度不同直接否，但仍走下方常量时间比较
  return crypto.timingSafeEqual(ba, bb);
}

/* 读取请求体：把 POST 的 JSON 体收集成字符串并解析为对象
 * 带 5MB 体积上限，防止超大请求拖垮服务器 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 5e6) reject(new Error("payload too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e); // JSON 解析失败 -> 交给调用方处理为 400
      }
    });
    req.on("error", reject);
  });
}

/* 统一 JSON 响应：写状态码 + JSON 头 + 序列化后的内容 */
function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

/* 从请求头里取指定名称的 Cookie 值（简单的正则提取） */
function getCookie(req, name) {
  const h = req.headers.cookie || "";
  const m = h.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? m[1] : null;
}

/* 校验会话：返回 token 表示有效，null 表示未登录或已过期
 * 过期时会顺手清掉内存里的记录 */
function getSession(req) {
  const token = getCookie(req, "session");
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiry) {
    sessions.delete(token);
    return null;
  }
  return token;
}

/* =========================================================
 * data.js 的注释模板
 * 后台保存时会连同数据一起写回文件，所以详细注释不会丢。
 * 每个常量都以「const XXX = 」结尾，后面直接接数据字面量。
 * ========================================================= */
const DATA_HEADER =
  "/* =========================================================\n" +
  " * Anhuann · 内容配置文件（data.js）\n" +
  " * ---------------------------------------------------------\n" +
  " * 这是整个网站唯一需要日常维护的文件。\n" +
  " *\n" +
  " * 它只做一件事：把网站要展示的所有文字内容，定义成几个\n" +
  " * 全局常量（SITE / ABOUT / POSTS / SOCIALS / UI），供 main.js 读取并渲染。\n" +
  " *\n" +
  " * 你（站长）平时改网站，只需要改这个文件：\n" +
  " *   - 改完保存，刷新浏览器即可生效（前台会实时从服务器读取）；\n" +
  " *   - 后台 admin.html 保存时，服务器也是把这个对象序列化回写本文件。\n" +
  " *\n" +
  " * 不需要动 index.html / style.css / main.js，除非你要改结构或样式。\n" +
  " *\n" +
  " * ─────────────────────────────────────────────\n" +
  " * 快速上手（三步）\n" +
  " * ─────────────────────────────────────────────\n" +
  " *   1. 改标题/文章/社交：直接改下面数组里的文字，保存。\n" +
  " *   2. 想加一篇新文章：复制下面 POSTS 里任意一个 { ... } 对象，\n" +
  " *      粘到数组末尾，改 title/date/tags/excerpt/body 即可。\n" +
  " *   3. 想加一个社交账号：复制 SOCIALS 里任意一个 { ... } 对象，\n" +
  " *      粘到末尾，按注释改字段即可。\n" +
  " *\n" +
  " * ─────────────────────────────────────────────\n" +
  " * 通用规则（很重要，先看这里）\n" +
  " * ─────────────────────────────────────────────\n" +
  " *   - 这里是「JavaScript 源码」，不是 JSON：\n" +
  " *       · 字符串用英文双引号 \"...\" 包起来；\n" +
  " *       · 字段之间用英文逗号 , 分隔（最后一项后面不要逗号）；\n" +
  " *       · 注释用 // 或块注释，不影响运行。\n" +
  " *     写错了常见症状：页面空白/控制台报错。\n" +
  " *     可用 node --check assets/js/data.js 自检语法。\n" +
  " *\n" +
  " *   - 字符串里想换行：写 \\n（例如 \"第一行\\n第二行\"）。\n" +
  " *\n" +
  " *   - 字符串里如果带 HTML 标签（如 <h3>、<strong>），会被原样渲染；\n" +
  " *     普通文本会被自动转义，所以你在正文里写 <b> 这类标签不会生效，\n" +
  " *     只有 body 数组中「以 < 开头」的元素才会按 HTML 原样插入。\n" +
  " *\n" +
  " *   - 正文（body）是「字符串数组」，每个元素是一段；\n" +
  " *     首字符为 \"<\" 的行会被当作 HTML 直接插入（用于小标题、列表、引用等）。\n" +
  " *\n" +
  " *   - 支持 LaTeX 公式（由本地 KaTeX 渲染，离线可用）：\n" +
  " *       行内公式  $E=mc^2$\n" +
  " *       块级公式  $$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$\n" +
  " *     也支持 \\( ... \\) 和 \\[ ... \\] 写法。\n" +
  " *     注意：$ 会被当作公式起始符，若要显示美元金额请写成 \\$5。\n" +
  " *\n" +
  " *   - 单引号 ' 和双引号 \" 如果出现在中文文案里没问题；\n" +
  " *     但如果出现在用双引号包裹的字符串内部，请写成 \\\" 转义，\n" +
  " *     否则会提前结束字符串。\n" +
  " * ========================================================= */\n\n";

const SEC_SITE =
  "/* =========================================================\n" +
  " * 1. SITE —— 站点级基础信息\n" +
  " *    控制首屏（hero）、导航站标、页脚、文档标题等全局位置。\n" +
  " *\n" +
  " *  字段说明：\n" +
  " *    name        站点名字，也是首屏大标题（带渐变文字效果），同时用于浏览器标签标题\n" +
  " *    initial     头像加载失败时显示的首字母（导航站标、首屏头像都用它兜底）\n" +
  " *    avatar      头像图片路径；相对站点根目录，建议放到 assets/img/ 下\n" +
  " *    greeting    首屏那一句打招呼的话（显示在大标题上方）\n" +
  " *    tagline     首屏副标题，一句话简介（显示在大标题下方）\n" +
  " *    description 首屏长一点的介绍（显示在副标题下方）\n" +
  " *    email       你的邮箱；显示在联系区「邮箱」卡片上\n" +
  " *               ★ 建议与下方 SOCIALS 里的邮箱卡保持一致\n" +
  " *    footerNote  页脚右侧的小备注（例如技术栈说明）\n" +
  " * ========================================================= */\n" +
  "const SITE = ";

const SEC_ABOUT =
  "/* =========================================================\n" +
  " * 2. ABOUT ——「关于我」板块内容\n" +
  " *    这个板块已做成「可折叠（手风琴）」：每张卡的标题可点击展开/收起正文，\n" +
  " *    板块里还有一个「全部展开 / 全部收起」开关。默认全部收起。\n" +
  " *\n" +
  " *  字段说明：\n" +
  " *    intro   一句引入语，显示在板块标题下方（普通文本，会转义）\n" +
  " *    themes  「主题故事卡」数组，每个对象包含：\n" +
  " *               title  卡片标题（点击它可展开/收起正文）\n" +
  " *               body   段落数组，每个元素是一段；同样支持 HTML / LaTeX\n" +
  " *\n" +
  " *    前端会按 themes 的数组顺序，给每张卡自动编号（1、2、3 …），\n" +
  " *    所以「编号」不用你写，顺序即为展示顺序。\n" +
  " *\n" +
  " *  ★ 想加一张新卡：在 themes 数组末尾加一个对象，例如\n" +
  " *      { title: \"关于某个新主题\", body: [\"第一段文字。\", \"第二段文字。\"] }\n" +
  " *    （记得给上一个对象的右花杠 } 后面补一个英文逗号）\n" +
  " * ========================================================= */\n" +
  "const ABOUT = ";

const SEC_POSTS =
  "/* =========================================================\n" +
  " * 3. POSTS —— 博客文章列表\n" +
  " *    数组里的每个对象是一篇文章，会渲染成首页的「文章卡片」，\n" +
  " *    点击后弹出详情弹窗（modal）展示完整正文。\n" +
  " *\n" +
  " *  字段说明：\n" +
  " *    title    文章标题\n" +
  " *    date     发布日期；建议写成 YYYY-MM-DD（如 \"2026-09-28\"），仅用于展示，\n" +
  " *            前台会格式化成 2026.09.28（卡片）和 2026 年 9 月 28 日（详情）\n" +
  " *    tags     标签数组，会在卡片和详情里显示为标签胶囊，例如 [\"随笔\", \"建站\"]\n" +
  " *    excerpt  摘要，卡片上显示的一句话简介\n" +
  " *    body     正文，「字符串数组」，每个元素是一段：\n" +
  " *               - 普通文本：渲染成一个 <p> 段落（自动转义）\n" +
  " *               - 以 \"<\" 开头的行：按 HTML 原样插入，可用\n" +
  " *                   <h3>小标题</h3>、<strong>加粗</strong>、<em>斜体</em>、\n" +
  " *                   <blockquote>引用</blockquote>、<ul><li>列表</li></ul>、\n" +
  " *                   <code>行内代码</code>\n" +
  " *               - 行内公式 $...$，块级公式 $$...$$\n" +
  " *\n" +
  " *  ★ 新增一篇文章：复制下面任意一个 { ... } 对象，粘到数组末尾（注意逗号），改字段即可。\n" +
  " * ========================================================= */\n" +
  "const POSTS = ";

const SEC_SOCIALS =
  "/* =========================================================\n" +
  " * 4. SOCIALS —— 社交账号与联系方式\n" +
  " *    数组里的每个对象是一张「联系卡片」，渲染在首页联系区；\n" +
  " *    可跳转的账号同时会以「小图标」出现在首屏和页脚。\n" +
  " *\n" +
  " *  字段说明：\n" +
  " *    name    显示名称（如 GitHub、微信、哔哩哔哩）\n" +
  " *    handle  账号文本；当卡片是「复制型」时，点击即复制这段文字\n" +
  " *    url     跳转链接。规则：\n" +
  " *              · 以 http(s):// 开头 → 新标签页打开\n" +
  " *              · mailto: 开头       → 调起邮件客户端\n" +
  " *              · \"\"（留空）         → 不可跳转，按「复制 handle」处理\n" +
  " *    icon    图标名，可用值（对应 main.js 顶部的 ICONS 映射）：\n" +
  " *              github / mail / x / wechat / bilibili / zhihu / douyin / rss / globe\n" +
  " *            ★ 想用新图标：在 main.js 的 ICONS 里加一段 SVG path，再在这里引用名字\n" +
  " *    copy    true  = 点击复制 handle（适合微信/抖音这类不方便跳转的）\n" +
  " *            false = 整卡可跳转（点击打开 url）\n" +
  " *    color   徽章渐变色，两个色值 [左, 右]，只影响卡片左上角小图标的底色\n" +
  " *\n" +
  " *  注意：icon 为 \"mail\" 的邮箱卡不会被放进联系区网格（由 initSocials 过滤），\n" +
  " *        它只出现在首屏的小图标胶囊里；其余可跳转的都会进网格。\n" +
  " * ========================================================= */\n" +
  "const SOCIALS = ";

const SEC_UI =
  "/* =========================================================\n" +
  " * 5. UI —— 界面固定文案（结构上的文字都在这里改）\n" +
  " *    这些原本写死在 index.html / main.js 里，现在统一收到这里，\n" +
  " *    后台「界面文案」标签页可以直接改，不用碰代码。\n" +
  " *\n" +
  " *  字段说明：\n" +
  " *    metaDescription  搜索引擎结果里显示的站点描述\n" +
  " *    metaKeywords     站点关键词（逗号分隔）\n" +
  " *    nav              顶部导航 + 手机菜单的文字（home/about/blog/contact）\n" +
  " *    hero.primaryBtn  首屏主按钮文字\n" +
  " *    hero.ghostBtn    首屏次按钮文字\n" +
  " *    hero.scrollHint  首屏底部「向下滚动」提示（给读屏软件用的无障碍文字）\n" +
  " *    about.kicker/title/sub  「关于我」板块的小标签/标题/副标题\n" +
  " *    blog.kicker/title/sub   「博客」板块的小标签/标题/副标题\n" +
  " *    blog.emptyHint         没有文章时显示的提示文字\n" +
  " *    contact.kicker/title/sub 「联系」板块的小标签/标题/副标题\n" +
  " * ========================================================= */\n" +
  "const UI = ";

/* =========================================================
 * 内容读写（以 data.js 为唯一内容源）
 * GET 时解析它；POST 时把新内容序列化回写它（含完整注释）。
 * ========================================================= */

/* 从 data.js 取出当前内容对象。
 * 技巧：data.js 用 const 声明各区块，无法直接 require。
 * 这里把文件当代码用 new Function 执行，再 return 出这些变量，得到纯对象。
 * （这是本站自己的文件，不是不可信输入，因此这种用法是安全的。） */
function extractContent() {
  // 优先读 DATA_DIR 下的 data.js；若（如 NAS 首次挂载为空）不存在，则退回代码内置副本
  const src = fs.existsSync(DATA_JS)
    ? DATA_JS
    : path.join(ROOT, "assets", "js", "data.js");
  const code = fs.readFileSync(src, "utf8");
  const fn = new Function(
    code +
      '\nreturn { SITE: SITE, ABOUT: ABOUT, POSTS: POSTS, SOCIALS: SOCIALS, UI: (typeof UI !== "undefined" ? UI : {}) };'
  );
  const o = fn();
  return {
    site: o.SITE,
    about: o.ABOUT,
    posts: o.POSTS,
    socials: o.SOCIALS,
    ui: o.UI,
  };
}

/* 把一个 JS 值序列化成「可读的源码文本」（字符串/数字/布尔/数组/对象）。
 * 用于把后台提交的对象重新生成为 data.js 里的字面量。
 * 字符串走 JSON.stringify，天然带双引号并转义，且仍是合法 JS。 */
function jsVal(v, indent) {
  const pad = "  ".repeat(indent);
  const pad1 = "  ".repeat(indent + 1);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return (
      "[\n" +
      v.map((x) => pad1 + jsVal(x, indent + 1)).join(",\n") +
      "\n" +
      pad +
      "]"
    );
  }
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (!keys.length) return "{}";
    return (
      "{\n" +
      keys
        .map((k) => pad1 + JSON.stringify(k) + ": " + jsVal(v[k], indent + 1))
        .join(",\n") +
      "\n" +
      pad +
      "}"
    );
  }
  return "null";
}

/* 把内容对象序列化为完整 data.js 文本（含完整注释）。
 * 顺序固定：SITE -> ABOUT -> POSTS -> SOCIALS -> UI，与前台读取一致。 */
function serializeData(c) {
  const ui = c.ui && typeof c.ui === "object" ? c.ui : {};
  return (
    DATA_HEADER +
    SEC_SITE +
    jsVal(c.site, 0) +
    ";\n\n" +
    SEC_ABOUT +
    jsVal(c.about, 0) +
    ";\n\n" +
    SEC_POSTS +
    jsVal(c.posts, 0) +
    ";\n\n" +
    SEC_SOCIALS +
    jsVal(c.socials, 0) +
    ";\n\n" +
    SEC_UI +
    jsVal(ui, 0) +
    ";\n"
  );
}

/* =========================================================
 * 自动备份
 * 每次写入 data.js 前，先把当前文件复制一份到 backups/（带时间戳），
 * 只保留最近 BACKUP_KEEP 份。备份失败不影响正常保存。
 * ========================================================= */
function backupData() {
  try {
    if (!fs.existsSync(DATA_JS)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date();
    const pad = (n, w) => String(n).padStart(w || 2, "0");
    // 文件名精确到毫秒：避免同一秒内的多次备份互相覆盖
    // （尤其「恢复备份」时会先备份当前内容，不能覆盖掉正要恢复的那份）
    const stamp =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
      `-${pad(d.getMilliseconds(), 3)}`;
    fs.copyFileSync(DATA_JS, path.join(BACKUP_DIR, "data-" + stamp + ".js"));
    // 只保留最近 N 份（文件名带时间戳，按字典序即时间序）
    const files = listBackupNames();
    while (files.length > BACKUP_KEEP) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    }
  } catch (e) {
    /* 备份失败不阻塞保存 */
  }
}
// 列出备份文件名（旧 -> 新）
function listBackupNames() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => /^data-\d{8}-\d{6}-\d{3}\.js$/.test(f))
      .sort();
  } catch (e) {
    return [];
  }
}

/* =========================================================
 * API 处理函数
 * ========================================================= */

/* 登录：校验账号密码，成功则生成随机令牌存入会话，并通过
 * Set-Cookie 下发 HttpOnly + SameSite=Lax 的会话 Cookie。 */
function handleLogin(req, res) {
  const ip = req.socket.remoteAddress || "unknown";

  // 防爆破：已锁定时直接拒绝，并告诉用户还要等多久
  const lockMin = loginLockMinutes(ip);
  if (lockMin > 0) {
    return sendJSON(res, 429, {
      ok: false,
      error: `尝试次数过多，请 ${lockMin} 分钟后再试`,
    });
  }

  readBody(req)
    .then((body) => {
      // 用常量时间比较，避免计时攻击
      const okUser = timingSafeEqual(body.user || "", ADMIN_USER);
      const okPass = timingSafeEqual(body.pass || "", ADMIN_PASS);
      if (okUser && okPass) {
        loginFails.delete(ip); // 登录成功即清零失败计数
        const token = crypto.randomBytes(32).toString("hex"); // 256-bit 随机令牌
        const ttl = body.remember ? REMEMBER_TTL : SESSION_TTL; // 勾选记住我则更长
        sessions.set(token, { expiry: Date.now() + ttl });
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          // HttpOnly：JS 读不到，降低 XSS 窃取风险；SameSite=Lax：跨站请求不自动带
          "Set-Cookie":
            "session=" +
            token +
            "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" +
            Math.floor(ttl / 1000),
        });
        res.end(JSON.stringify({ ok: true }));
      } else {
        // 失败：计数，达到上限就锁定
        loginRecordFail(ip);
        const nowLock = loginLockMinutes(ip);
        if (nowLock > 0) {
          return sendJSON(res, 429, {
            ok: false,
            error: `失败次数过多，已锁定 ${nowLock} 分钟`,
          });
        }
        sendJSON(res, 401, { ok: false, error: "账号或密码不正确" });
      }
    })
    .catch(() => sendJSON(res, 400, { ok: false, error: "请求格式错误" }));
}

/* 内容接口：GET 公开（前台动态读取），POST 需登录（后台保存） */
function handleContent(req, res) {
  // GET：任何人都能读（网站内容本就公开），直接返回当前内容
  if (req.method === "GET") {
    try {
      sendJSON(res, 200, extractContent());
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: "读取内容失败" });
    }
    return;
  }

  // POST 需登录：写入内容
  const token = getSession(req);
  if (!token) return sendJSON(res, 401, { ok: false, error: "未登录" });

  if (req.method === "POST") {
    readBody(req)
      .then((body) => {
        // 基本结构校验：五个区块都不能缺
        if (
          !body ||
          typeof body !== "object" ||
          !body.site ||
          !body.about ||
          !body.posts ||
          !body.socials ||
          !body.ui
        ) {
          return sendJSON(res, 400, { ok: false, error: "内容格式不正确" });
        }
        try {
          backupData(); // 写前先备份，防止误操作无法回退
          fs.mkdirSync(path.dirname(DATA_JS), { recursive: true });
          const serialized = serializeData(body);
          fs.writeFileSync(DATA_JS, serialized, "utf8");
          // 永久化：把最新 data.js 提交回 GitHub（best-effort，失败不阻断本地保存）
          if (GH_TOKEN) {
            commitToGitHub(serialized)
              .then(() => console.log("[github] data.js 已同步到仓库 " + GH_OWNER + "/" + GH_REPO))
              .catch((e) => console.error("[github] 同步仓库失败（本地已保存）：", e.message));
          } else {
            console.warn("[github] 未配置 GH_TOKEN，保存仅在本机生效，重启可能丢失");
          }
          sendJSON(res, 200, { ok: true });
        } catch (e) {
          sendJSON(res, 500, { ok: false, error: "写入失败" });
        }
      })
      .catch(() => sendJSON(res, 400, { ok: false, error: "请求格式错误" }));
    return;
  }

  // 其它方法（PUT/DELETE 等）不允许
  sendJSON(res, 405, { ok: false, error: "方法不允许" });
}

/* 会话探测：后台启动时用它判断「我是否已登录」，从而决定是否直接进后台 */
function handleSession(req, res) {
  const token = getSession(req);
  if (token) return sendJSON(res, 200, { ok: true });
  return sendJSON(res, 401, { ok: false, error: "未登录" });
}

/* 登出：删除内存会话，并把 Cookie 的 Max-Age 置 0 让它立即失效 */
function handleLogout(req, res) {
  const token = getCookie(req, "session");
  if (token) sessions.delete(token);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
  });
  res.end(JSON.stringify({ ok: true }));
}

/* 备份列表：给后台「恢复备份」弹窗用 */
function handleBackups(req, res) {
  const token = getSession(req);
  if (!token) return sendJSON(res, 401, { ok: false, error: "未登录" });
  try {
    const backups = listBackupNames()
      .reverse() // 新的在前
      .map((name) => {
        const st = fs.statSync(path.join(BACKUP_DIR, name));
        return {
          name,
          size: st.size,
          time: name.replace(/^data-/, "").replace(/\.js$/, ""),
        };
      });
    sendJSON(res, 200, { ok: true, backups });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: "读取备份列表失败" });
  }
}

/* 恢复备份：用指定备份覆盖当前 data.js（恢复前也会先备份当前内容） */
function handleRestore(req, res) {
  const token = getSession(req);
  if (!token) return sendJSON(res, 401, { ok: false, error: "未登录" });
  readBody(req)
    .then((body) => {
      const name = String((body && body.name) || "");
      // 严格校验文件名，防止路径穿越（只允许 data-YYYYMMDD-HHMMSS.js）
      if (!/^data-\d{8}-\d{6}-\d{3}\.js$/.test(name)) {
        return sendJSON(res, 400, { ok: false, error: "备份文件名不合法" });
      }
      const src = path.join(BACKUP_DIR, name);
      if (!fs.existsSync(src)) {
        return sendJSON(res, 404, { ok: false, error: "备份不存在" });
      }
      try {
        backupData(); // 恢复前先把当前内容也备份一份
        fs.mkdirSync(path.dirname(DATA_JS), { recursive: true });
        fs.copyFileSync(src, DATA_JS);
        sendJSON(res, 200, { ok: true });
      } catch (e) {
        sendJSON(res, 500, { ok: false, error: "恢复失败" });
      }
    })
    .catch(() => sendJSON(res, 400, { ok: false, error: "请求格式错误" }));
}

/* =========================================================
 * 静态文件服务
 * 只放行白名单路径，避免把服务器源码（server.js、backups 等）泄漏出去。
 * ========================================================= */
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html"; // 根路径默认给首页

  // 白名单：只允许首页、后台页、以及 assets 目录下的资源
  const allowed =
    urlPath === "/index.html" ||
    urlPath === "/admin.html" ||
    urlPath.startsWith("/assets/");
  if (!allowed) {
    res.writeHead(404);
    return res.end("Not found");
  }

  // 拼路径并防目录穿越：最终路径必须仍位于 ROOT 内
  const fp = path.normalize(path.join(ROOT, urlPath));
  if (fp !== ROOT && !fp.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(fp, (e, d) => {
    if (e) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(fp).toLowerCase();
    const headers = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      // 阿里云 FC 的 HTTP 触发器默认会给响应加 Content-Disposition: attachment，
      // 导致浏览器把 HTML 当文件下载。这里显式声明 inline，让浏览器正常渲染页面。
      "Content-Disposition": "inline",
    };
    // JS/CSS 不缓存，保证后台保存后前台能立刻拿到新内容
    if (ext === ".js" || ext === ".css") headers["Cache-Control"] = "no-cache";
    res.writeHead(200, headers);
    res.end(d);
  });
}

/* =========================================================
 * 路由：根据 URL + 方法分发到对应处理函数
 * 外面包一层 try/catch：万一某个处理函数抛异常，也只让这一个请求
 * 返回 500，不会把整个服务器进程带崩。
 * ========================================================= */
const server = http.createServer((req, res) => {
  const p = req.url.split("?")[0]; // 去掉查询串只看路径
  try {
    if (p === "/api/login" && req.method === "POST") return handleLogin(req, res);
    if (p === "/api/logout" && req.method === "POST") return handleLogout(req, res);
    if (p === "/api/session" && req.method === "GET") return handleSession(req, res);
    if (p === "/api/backups" && req.method === "GET") return handleBackups(req, res);
    if (p === "/api/restore" && req.method === "POST") return handleRestore(req, res);
    if (p === "/api/content") return handleContent(req, res); // GET/POST 都在内部区分
    if (p.startsWith("/api/")) {
      res.writeHead(404);
      return res.end("Not found"); // 未定义的 API 一律 404
    }
    return serveStatic(req, res); // 其余交给静态文件服务
  } catch (e) {
    console.error("请求处理异常：" + (e && e.stack ? e.stack : e));
    if (!res.headersSent) {
      sendJSON(res, 500, { ok: false, error: "服务器内部错误" });
    } else {
      res.end();
    }
  }
});

// 启动监听，并打印访问地址
server.listen(PORT, () => {
  console.log("Anhuann 服务器已启动： http://localhost:" + PORT);
  console.log("前台： http://localhost:" + PORT + "/");
  console.log("后台： http://localhost:" + PORT + "/admin.html");
});
