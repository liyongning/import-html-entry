/**
 * @author Kuitos
 * @homepage https://github.com/kuitos/
 * @since 2018-09-03 15:04
 */
import { getInlineCode, isModuleScriptSupported } from './utils';

const ALL_SCRIPT_REGEX = /(<script[\s\S]*?>)[\s\S]*?<\/script>/gi;
const SCRIPT_TAG_REGEX = /<(script)\s+((?!type=('|')text\/ng-template\3).)*?>.*?<\/\1>/is;
const SCRIPT_SRC_REGEX = /.*\ssrc=('|")?([^>'"\s]+)/;
const SCRIPT_TYPE_REGEX = /.*\stype=('|")?([^>'"\s]+)/;
const SCRIPT_ENTRY_REGEX = /.*\sentry\s*.*/;
const SCRIPT_ASYNC_REGEX = /.*\sasync\s*.*/;
const SCRIPT_NO_MODULE_REGEX = /.*\snomodule\s*.*/;
const SCRIPT_MODULE_REGEX = /.*\stype=('|")?module('|")?\s*.*/;
const LINK_TAG_REGEX = /<(link)\s+.*?>/isg;
const LINK_PRELOAD_OR_PREFETCH_REGEX = /\srel=('|")?(preload|prefetch)\1/;
const LINK_HREF_REGEX = /.*\shref=('|")?([^>'"\s]+)/;
const LINK_AS_FONT = /.*\sas=('|")?font\1.*/;
const STYLE_TAG_REGEX = /<style[^>]*>[\s\S]*?<\/style>/gi;
const STYLE_TYPE_REGEX = /\s+rel=('|")?stylesheet\1.*/;
const STYLE_HREF_REGEX = /.*\shref=('|")?([^>'"\s]+)/;
const HTML_COMMENT_REGEX = /<!--([\s\S]*?)-->/g;
const LINK_IGNORE_REGEX = /<link(\s+|\s+.+\s+)ignore(\s*|\s+.*|=.*)>/is;
const STYLE_IGNORE_REGEX = /<style(\s+|\s+.+\s+)ignore(\s*|\s+.*|=.*)>/is;
const SCRIPT_IGNORE_REGEX = /<script(\s+|\s+.+\s+)ignore(\s*|\s+.*|=.*)>/is;

function hasProtocol(url) {
	return url.startsWith('//') || url.startsWith('http://') || url.startsWith('https://');
}

function getEntirePath(path, baseURI) {
	return new URL(path, baseURI).toString();
}

function isValidJavaScriptType(type) {
	const handleTypes = ['text/javascript', 'module', 'application/javascript', 'text/ecmascript', 'application/ecmascript'];
	return !type || handleTypes.indexOf(type) !== -1;
}

export const genLinkReplaceSymbol = (linkHref, preloadOrPrefetch = false) => `<!-- ${preloadOrPrefetch ? 'prefetch/preload' : ''} link ${linkHref} replaced by import-html-entry -->`;
export const genScriptReplaceSymbol = (scriptSrc, async = false) => `<!-- ${async ? 'async' : ''} script ${scriptSrc} replaced by import-html-entry -->`;
export const inlineScriptReplaceSymbol = `<!-- inline scripts replaced by import-html-entry -->`;
export const genIgnoreAssetReplaceSymbol = url => `<!-- ignore asset ${url || 'file'} replaced by import-html-entry -->`;
export const genModuleScriptReplaceSymbol = (scriptSrc, moduleSupport) => `<!-- ${moduleSupport ? 'nomodule' : 'module'} script ${scriptSrc} ignored by import-html-entry -->`;

/**
 * 从 html 模版中解析出外部脚本的地址或者行内脚本的代码块 和 link 标签的地址
 * @param tpl html 模版
 * @param baseURI
 * @stripStyles whether to strip the css links
 * @returns {{template: void | string | *, scripts: *[], entry: *}}
 * return {
 * 	template: 经过处理的脚本，link、script 标签都被注释掉了,
 * 	scripts: [脚本的http地址 或者 { async: true, src: xx } 或者 代码块],
 *  styles: [样式的http地址],
 * 	entry: 入口脚本的地址，要不是标有 entry 的 script 的 src，要不就是最后一个 script 标签的 src
 * }
 */
export default function processTpl(tpl, baseURI) {

	let scripts = [];
	const styles = [];
	let entry = null;
	// 判断浏览器是否支持 es module，<script type = "module" />
	const moduleSupport = isModuleScriptSupported();

	const template = tpl

		// 移除 html 模版中的注释内容 <!-- xx -->
		.replace(HTML_COMMENT_REGEX, '')

		// 匹配 link 标签
		.replace(LINK_TAG_REGEX, match => {
			/**
			 * 将模版中的 link 标签变成注释，如果有存在 href 属性且非预加载的 link，则将地址存到 styles 数组，如果是预加载的 link 直接变成注释
			 */
			// <link rel = "stylesheet" />
			const styleType = !!match.match(STYLE_TYPE_REGEX);
			if (styleType) {

				// <link rel = "stylesheet" href = "xxx" />
				const styleHref = match.match(STYLE_HREF_REGEX);
				// <link rel = "stylesheet" ignore />
				const styleIgnore = match.match(LINK_IGNORE_REGEX);

				if (styleHref) {

					// 获取 href 属性值
					const href = styleHref && styleHref[2];
					let newHref = href;

					// 如果 href 没有协议说明给的是一个相对地址，拼接 baseURI 得到完整地址
					if (href && !hasProtocol(href)) {
						newHref = getEntirePath(href, baseURI);
					}
					// 将 <link rel = "stylesheet" ignore /> 变成 <!-- ignore asset ${url} replaced by import-html-entry -->
					if (styleIgnore) {
						return genIgnoreAssetReplaceSymbol(newHref);
					}

					// 将 href 属性值存入 styles 数组
					styles.push(newHref);
					// <link rel = "stylesheet" href = "xxx" /> 变成 <!-- link ${linkHref} replaced by import-html-entry -->
					return genLinkReplaceSymbol(newHref);
				}
			}

			// 匹配 <link rel = "preload or prefetch" href = "xxx" />，表示预加载资源
			const preloadOrPrefetchType = match.match(LINK_PRELOAD_OR_PREFETCH_REGEX) && match.match(LINK_HREF_REGEX) && !match.match(LINK_AS_FONT);
			if (preloadOrPrefetchType) {
				// 得到 href 地址
				const [, , linkHref] = match.match(LINK_HREF_REGEX);
				// 将标签变成 <!-- prefetch/preload link ${linkHref} replaced by import-html-entry -->
				return genLinkReplaceSymbol(linkHref, true);
			}

			return match;
		})
		// 匹配 <style></style>
		.replace(STYLE_TAG_REGEX, match => {
			if (STYLE_IGNORE_REGEX.test(match)) {
				// <style ignore></style> 变成 <!-- ignore asset style file replaced by import-html-entry -->
				return genIgnoreAssetReplaceSymbol('style file');
			}
			return match;
		})
		// 匹配 <script></script>
		.replace(ALL_SCRIPT_REGEX, (match, scriptTag) => {
			// 匹配 <script ignore></script>
			const scriptIgnore = scriptTag.match(SCRIPT_IGNORE_REGEX);
			// 匹配 <script nomodule></script> 或者 <script type = "module"></script>，都属于应该被忽略的脚本
			const moduleScriptIgnore =
				(moduleSupport && !!scriptTag.match(SCRIPT_NO_MODULE_REGEX)) ||
				(!moduleSupport && !!scriptTag.match(SCRIPT_MODULE_REGEX));
			// in order to keep the exec order of all javascripts

			// <script type = "xx" />
			const matchedScriptTypeMatch = scriptTag.match(SCRIPT_TYPE_REGEX);
			// 获取 type 属性值
			const matchedScriptType = matchedScriptTypeMatch && matchedScriptTypeMatch[2];
			// 验证 type 是否有效，type 为空 或者 'text/javascript', 'module', 'application/javascript', 'text/ecmascript', 'application/ecmascript'，都视为有效
			if (!isValidJavaScriptType(matchedScriptType)) {
				return match;
			}

			// if it is a external script，匹配非 <script type = "text/ng-template" src = "xxx"></script>
			if (SCRIPT_TAG_REGEX.test(match) && scriptTag.match(SCRIPT_SRC_REGEX)) {
				/*
				collect scripts and replace the ref
				*/

				// <script entry />
				const matchedScriptEntry = scriptTag.match(SCRIPT_ENTRY_REGEX);
				// <script src = "xx" />
				const matchedScriptSrcMatch = scriptTag.match(SCRIPT_SRC_REGEX);
				// 脚本地址
				let matchedScriptSrc = matchedScriptSrcMatch && matchedScriptSrcMatch[2];

				if (entry && matchedScriptEntry) {
					// 说明出现了两个入口地址，即两个 <script entry src = "xx" />
					throw new SyntaxError('You should not set multiply entry script!');
				} else {
					// 补全脚本地址，地址如果没有协议，说明是一个相对路径，添加 baseURI
					if (matchedScriptSrc && !hasProtocol(matchedScriptSrc)) {
						matchedScriptSrc = getEntirePath(matchedScriptSrc, baseURI);
					}

					// 脚本的入口地址
					entry = entry || matchedScriptEntry && matchedScriptSrc;
				}

				if (scriptIgnore) {
					// <script ignore></script> 替换为 <!-- ignore asset ${url || 'file'} replaced by import-html-entry -->
					return genIgnoreAssetReplaceSymbol(matchedScriptSrc || 'js file');
				}

				if (moduleScriptIgnore) {
					// <script nomodule></script> 或者 <script type = "module"></script> 替换为
					// <!-- nomodule script ${scriptSrc} ignored by import-html-entry --> 或
					// <!-- module script ${scriptSrc} ignored by import-html-entry -->
					return genModuleScriptReplaceSymbol(matchedScriptSrc || 'js file', moduleSupport);
				}

				if (matchedScriptSrc) {
					// 匹配 <script src = 'xx' async />，说明是异步加载的脚本
					const asyncScript = !!scriptTag.match(SCRIPT_ASYNC_REGEX);
					// 将脚本地址存入 scripts 数组，如果是异步加载，则存入一个对象 { async: true, src: xx }
					scripts.push(asyncScript ? { async: true, src: matchedScriptSrc } : matchedScriptSrc);
					// <script src = "xx" async /> 或者 <script src = "xx" /> 替换为 
					// <!-- async script ${scriptSrc} replaced by import-html-entry --> 或 
					// <!-- script ${scriptSrc} replaced by import-html-entry -->
					return genScriptReplaceSymbol(matchedScriptSrc, asyncScript);
				}

				return match;
			} else {
				// 说明是内部脚本，<script>xx</script>
				if (scriptIgnore) {
					// <script ignore /> 替换为 <!-- ignore asset js file replaced by import-html-entry -->
					return genIgnoreAssetReplaceSymbol('js file');
				}

				if (moduleScriptIgnore) {
					// <script nomodule></script> 或者 <script type = "module"></script> 替换为
					// <!-- nomodule script ${scriptSrc} ignored by import-html-entry --> 或 
					// <!-- module script ${scriptSrc} ignored by import-html-entry -->
					return genModuleScriptReplaceSymbol('js file', moduleSupport);
				}

				// if it is an inline script，<script>xx</script>，得到标签之间的代码 => xx
				const code = getInlineCode(match);

				// remove script blocks when all of these lines are comments. 判断代码块是否全是注释
				const isPureCommentBlock = code.split(/[\r\n]+/).every(line => !line.trim() || line.trim().startsWith('//'));

				if (!isPureCommentBlock) {
					// 不是注释，则将代码块存入 scripts 数组
					scripts.push(match);
				}

				// <script>xx</script> 替换为 <!-- inline scripts replaced by import-html-entry -->
				return inlineScriptReplaceSymbol;
			}
		});

	// filter empty script
	scripts = scripts.filter(function (script) {
		return !!script;
	});

	return {
		template,
		scripts,
		styles,
		// set the last script as entry if have not set
		entry: entry || scripts[scripts.length - 1],
	};
}
