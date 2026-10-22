/**
 * dsh-modeltrace — browser half (hand-written lazy-CJS bundle, no build step).
 *
 * Loader contract: `window.__ModuleLoader__.load({ id, factory })` registers the factory;
 * the shell materialises it with `factory(require)` on first import and memoises
 * `module.exports`. The exports must be a cordis plugin: `{ name, inject, apply }`.
 *
 * The browser module table only resolves the platform seed words plus already
 * materialised peer bundles. `react` is a seed word; everything else is written
 * by hand with `React.createElement` (no JSX runtime, no npm deps, no local imports).
 *
 * Card contract (plugins.item, keyed by the Host plugin entry):
 *   ctx.configForms.whileServed([namespace], () => ctx.slots.inject("plugins.item", () =>
 *     ctx.slots.register({ name: "plugins.item", id, order, label }, Card)))
 * Owner props are `{}` in this version, so the component tolerates both
 * `view: 'summary'` (Plugins page) and `view: 'page'` (its own page) and also
 * renders the full form when no `view` is supplied at all.
 */
window.__ModuleLoader__.load({
  id: "dsh-modeltrace",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    var React = require("react");
    if (React && React.default && typeof React.createElement !== "function") React = React.default;
    var h = React.createElement;

    var NAME = "dsh-modeltrace";
    var SETTINGS_NAMESPACE = "modeltrace";
    var CARD_SLOTS = ["plugins.item", "settings.plugins.tab"];
    var RESULT_SLOT = "conversation.session.header.utilities";
    var dismissedRuns = new Map();

    // Editable fields are served by the host Config's volatile form.
    var DEFAULTS = {
      enabled: true, enforce: "block", rounds: 3, countMin: 218, countMax: 400,
      minMatchConfidence: 0.8, detailBelowConfidence: 0.9, injectOnMatch: true,
      intervalMessages: "", intervalSeconds: "", verificationMode: "probe",
      timeoutMs: 300000, floatingWindow: true, injectVerdict: true
    };
    var ENFORCE_OPTIONS = [
      { value: "block", label: "block — 指纹不一致时锁定任务" },
      { value: "warn", label: "warn — 仅提示，不拦截" },
      { value: "off", label: "off — 仅记录，不干预" }
    ];
    var FIELDS = [
      { key: "enabled", type: "boolean", label: "总开关", hint: "关闭后停止校验，不探测也不拦截。" },
      { key: "enforce", type: "enum", options: ENFORCE_OPTIONS, label: "指纹不一致时的动作", hint: "block 锁定任务 / warn 仅提示 / off 仅记录。" },
      { key: "rounds", type: "number", min: 1, max: 5, step: 1, label: "测试轮数（1-5）", hint: "默认 3 轮。" },
      { key: "countMin", type: "number", min: 218, max: 400, step: 1, label: "每轮随机数字个数下限", hint: "最小 218。" },
      { key: "countMax", type: "number", min: 218, max: 400, step: 1, label: "每轮随机数字个数上限", hint: "最大 400，且不应小于下限。" },
      { key: "minMatchConfidence", type: "number", min: 0, max: 1, step: 0.05, label: "判定通过的最低置信度（0-1）", hint: "默认 0.8；低于此值时无法判定。" },
      { key: "detailBelowConfidence", type: "number", min: 0, max: 1, step: 0.05, label: "低于此置信度就列出候选明细", hint: "默认 0.9；结果窗始终列出前三候选和每轮最高置信度。" },
      { key: "intervalMessages", type: "number", min: 0, step: 1, nullable: true, stringValue: true, label: "X1 · 用户消息间隔", hint: "留空不启用；只计用户消息，不计工具步骤。0 表示每条消息校验。" },
      { key: "intervalSeconds", type: "number", min: 0, step: "any", nullable: true, stringValue: true, label: "X2 · 时间间隔（秒）", hint: "留空不启用；正数从上次校验完成计时，到期后后台自动校验。0 表示每条用户消息校验。" },
      { key: "verificationMode", type: "enum", label: "校验方式", hint: "默认独立探针，主会话不等待探针。实验会话模式默认关闭，以极简 DSH 会话完成长整数挑战并整合结果回主会话。", options: [
        { value: "probe", label: "独立探针（默认）" }, { value: "session", label: "DSH 会话（实验）" }
      ] },
      { key: "timeoutMs", type: "number", min: 1000, max: 1800000, step: 1, label: "单次校验超时（毫秒）", hint: "默认 300000（5 分钟），最大 1800000（30 分钟）。" },
      { key: "floatingWindow", type: "boolean", label: "显示结果悬浮窗", hint: "可关闭当次窗口；下次校验开始自动重现。与上下文注入独立。" },
      { key: "injectVerdict", type: "boolean", label: "保留上下文裁决注入", hint: "将裁决整合回主会话，让模型知道校验结果。" },
      { key: "injectOnMatch", type: "boolean", label: "校验通过时也注入汇报", hint: "通过时也注入一句话，让模型向你汇报结果。" }
    ];
    var RULES = "第一条用户消息先校验。X1 / X2 都填时 X1 优先；都空时会话仅最开始一条校验；只填一个时用那个。有效项为 0 时每条用户消息校验。X1 不计工具步骤；正数 X2 从上次校验完成计时，到期后后台自动校验，无需新消息。关闭总开关停止校验。指纹库外模型固定跳过。";

    /* ------------------------------------------------------------------ *
     * Styles
     * ------------------------------------------------------------------ */

    /*
     * 设计令牌取 DSH web 主题的 `--dsw-alias-*`（与内置卡片 fields.module.css 同源）。
     * 早先误用了不存在的 `--dsh-text`，回退值 #e6e6e6 在浅色主题下就是「一片灰」。
     * 每个 token 都带一个中性回退，令牌缺席时至少还可读。
     */
    var CSS = [
      ".mt-card{display:block;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,inherit)}",
      ".mt-head{display:flex;align-items:baseline;gap:8px;margin:0 0 4px}",
      ".mt-title{font-weight:600;font-size:14px;color:var(--dsw-alias-label-primary,inherit)}",
      ".mt-ns{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}",
      ".mt-status{margin:0 0 8px;font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}",
      ".mt-status[data-bad='1']{display:inline-block;padding:3px 9px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.08));border:1px solid var(--dsw-alias-state-error-primary,#ec1313);color:var(--dsw-alias-label-primary,inherit)}",
      ".mt-row{display:flex;flex-direction:column;gap:6px;padding:12px 0}",
      ".mt-row+.mt-row{border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}",
      ".mt-row-top{display:flex;align-items:center;gap:8px;min-width:0}",
      ".mt-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary,inherit)}",
      ".mt-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,inherit)}",
      ".mt-badge{flex:0 0 auto;font-size:11px;padding:1px 6px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18));color:var(--dsw-alias-label-secondary,inherit)}",
      ".mt-ctl{flex:0 0 auto;display:flex;align-items:center;gap:8px}",
      ".mt-ctl-wide{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}",
      ".mt-input{height:34px;min-width:0;font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.12));border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.4));border-radius:8px;padding:0 12px}",
      ".mt-input:focus-visible{border-color:var(--dsw-alias-brand-primary,#3b82f6);outline:none}",
      ".mt-input:disabled{color:var(--dsw-alias-label-secondary,inherit);cursor:default}",
      ".mt-num{width:120px}",
      ".mt-select{max-width:100%;min-width:min(100%,240px)}",
      ".mt-check{flex:0 0 auto;margin:0;width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary,#3b82f6)}",
      ".mt-btn{font:inherit;font-size:12px;line-height:1.5;padding:0;border:none;background:0 0;cursor:pointer;white-space:nowrap;color:var(--dsw-alias-label-secondary,inherit)}",
      ".mt-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary,inherit)}",
      ".mt-btn:disabled{color:var(--dsw-alias-label-secondary,inherit);cursor:default}",
      ".mt-foot{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px}",
      ".mt-err{margin-top:8px;font-size:12px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.08));border:1px solid var(--dsw-alias-state-error-primary,#ec1313);color:var(--dsw-alias-label-primary,inherit)}",
      ".mt-summary{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center}",
      ".mt-summary b{font-weight:600;color:var(--dsw-alias-label-primary,inherit)}",
      ".mt-float{position:fixed;right:16px;bottom:20px;z-index:1000;box-sizing:border-box;width:340px;max-width:calc(100vw - 32px);max-height:min(65vh,520px);overflow:auto;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.4));border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 8px 28px rgba(0,0,0,.16)}",
      ".mt-float .mt-head{align-items:center;justify-content:space-between}",
      ".mt-float ol{padding-left:20px;margin:6px 0}",
      ".mt-float p{margin:6px 0;overflow-wrap:anywhere}",
      ".mt-close{font:inherit;border:0;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit);padding:3px 8px;cursor:pointer}",
      ".mt-dim{color:var(--dsw-alias-label-tertiary,inherit)}"
    ].join("\n");

    function injectStyles() {
      if (typeof document === "undefined") return;
      var tagId = NAME + "/card";
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = NAME;
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ------------------------------------------------------------------ *
     * Small helpers
     * ------------------------------------------------------------------ */

    function isObject(value) {
      return value !== null && typeof value === "object";
    }

    function hasOwn(object, key) {
      return isObject(object) && Object.prototype.hasOwnProperty.call(object, key);
    }

    var EMPTY_SNAPSHOT = {
      status: "unavailable",
      value: {},
      base: {},
      user: {},
      revision: 0,
      writable: false
    };

    /** Reads the settings scope once: resolved value + which fields the user layer overrides. */
    function readScope(scope) {
      if (!scope || typeof scope.getSnapshot !== "function") return EMPTY_SNAPSHOT;
      try {
        var snapshot = scope.getSnapshot();
        return isObject(snapshot) ? snapshot : EMPTY_SNAPSHOT;
      } catch (error) {
        return EMPTY_SNAPSHOT;
      }
    }

    /** Subscribes a component to a SettingsScopeController via getSnapshot()/subscribe(). */
    function useScopeSnapshot(scope) {
      var pair = React.useState(function () {
        return readScope(scope);
      });
      var snapshot = pair[0];
      var setSnapshot = pair[1];
      React.useEffect(
        function () {
          if (!scope) return undefined;
          var sync = function () {
            setSnapshot(readScope(scope));
          };
          sync();
          if (typeof scope.subscribe !== "function") return undefined;
          var dispose = scope.subscribe(sync);
          return typeof dispose === "function" ? dispose : undefined;
        },
        [scope]
      );
      return snapshot;
    }

    function fieldValue(snapshot, field) {
      if (hasOwn(snapshot.value, field.key)) return snapshot.value[field.key];
      if (hasOwn(snapshot.base, field.key)) return snapshot.base[field.key];
      return DEFAULTS[field.key];
    }

    function isOverridden(snapshot, field) {
      return hasOwn(snapshot.user, field.key);
    }

    function formatValue(field, value) {
      if (field.type === "boolean") return value ? "开" : "关";
      if (field.type === "enum") {
        for (var i = 0; i < field.options.length; i += 1) {
          if (field.options[i].value === value) return value;
        }
        return String(value);
      }
      return value === undefined || value === null ? "—" : String(value);
    }

    /* ------------------------------------------------------------------ *
     * Components
     * ------------------------------------------------------------------ */

    function StatusLine(props) {
      var snapshot = props.snapshot;
      var status = snapshot.status;
      if (status === "ready") {
        return h("p", { className: "mt-status" }, props.writable ? "已连接宿主设置。" : "宿主设置当前只读。");
      }
      if (status === "loading") return h("p", { className: "mt-status" }, "正在读取宿主设置…");
      return h("p", { className: "mt-status", "data-bad": "1" }, "\u26a0 宿主设置不可用（status: " + String(status) + "）。");
    }

    function ResetButton(props) {
      return h(
        "button",
        {
          type: "button",
          className: "mt-btn",
          disabled: !props.enabled,
          title: props.enabled ? "清除 user 层覆盖，回到组装层默认值" : "当前使用默认值",
          onClick: props.onClick
        },
        "重置为默认"
      );
    }

    function BooleanControl(props) {
      return h("input", {
        type: "checkbox",
        "aria-label": props.label,
        className: "mt-check",
        checked: props.checked === true,
        disabled: props.disabled,
        onChange: function (event) {
          props.onCommit(event.target.checked);
        }
      });
    }

    function EnumControl(props) {
      return h(
        "select",
        {
          className: "mt-input mt-select",
          "aria-label": props.label,
          value: props.value === undefined ? "" : String(props.value),
          disabled: props.disabled,
          onChange: function (event) {
            props.onCommit(event.target.value);
          }
        },
        props.options.map(function (option) {
          return h("option", { key: option.value, value: option.value }, option.label);
        })
      );
    }

    function NumberControl(props) {
      var draftPair = React.useState(null);
      var draft = draftPair[0];
      var setDraft = draftPair[1];
      var shown = draft === null ? String(props.value === undefined || props.value === null ? "" : props.value) : draft;

      function commit() {
        if (draft === null) return;
        var parsed = Number(draft);
        setDraft(null);
        if (draft.trim() === "") {
          if (props.nullable) props.onCommit(props.stringValue ? "" : null);
          return;
        }
        if (!isFinite(parsed)) return;
        // 按 step 吸附，别一律 Math.round —— 那是整数假设，
        // 会把阈值 0.8 变成 1（step = 0.05 的那些配置项正是靠这里才成立）。
        var step = props.step === undefined || props.step <= 0 ? 1 : props.step;
        var next = props.step === "any" ? parsed : Number((Math.round(parsed / step) * step).toFixed(6));
        if (props.min !== undefined && next < props.min) next = props.min;
        if (props.max !== undefined && next > props.max) next = props.max;
        var stored = props.stringValue ? String(next) : next;
        if (stored !== props.value) props.onCommit(stored);
      }

      return h("input", {
        type: "number",
        className: "mt-input mt-num",
        "aria-label": props.label,
        placeholder: props.nullable ? "留空" : undefined,
        value: shown,
        min: props.min,
        max: props.max,
        step: props.step === undefined ? 1 : props.step,
        disabled: props.disabled,
        onChange: function (event) {
          setDraft(event.target.value);
        },
        onBlur: commit,
        onKeyDown: function (event) {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(null);
        }
      });
    }

    function FieldRow(props) {
      var field = props.field;
      var snapshot = props.snapshot;
      var overridden = isOverridden(snapshot, field);
      var value = fieldValue(snapshot, field);
      var disabled = props.disabled || snapshot.status !== "ready" || snapshot.writable === false;

      var control;
      if (field.type === "boolean") {
        control = h(BooleanControl, { checked: value === true, label: field.label, disabled: disabled, onCommit: props.onCommit });
      } else if (field.type === "enum") {
        control = h(EnumControl, { value: value, label: field.label, options: field.options, disabled: disabled, onCommit: props.onCommit });
      } else {
        control = h(NumberControl, {
          value: value,
          label: field.label,
          nullable: field.nullable,
          stringValue: field.stringValue,
          min: field.min,
          max: field.max,
          step: field.step,
          disabled: disabled,
          onCommit: props.onCommit
        });
      }

      var inline = field.type === "boolean";
      return h(
        "div",
        { className: "mt-row" },
        h(
          "div",
          { className: "mt-row-top" },
          h("div", { className: "mt-label" }, field.label, overridden ? h("span", { className: "mt-badge" }, "已自定义") : null),
          h(
            "div",
            { className: "mt-ctl" },
            inline ? control : null,
            h(ResetButton, { enabled: overridden && !disabled, onClick: props.onReset })
          )
        ),
        inline ? null : h("div", { className: "mt-ctl-wide" }, control),
        h("p", { className: "mt-hint" }, field.hint)
      );
    }

    function SummaryView(props) {
      var snapshot = props.snapshot;
      var overridden = FIELDS.filter(function (field) {
        return isOverridden(snapshot, field);
      }).length;
      var enabled = fieldValue(snapshot, FIELDS[0]) === true;
      var enabledText = enabled ? "已启用" : "已关闭";
      var enforceText = formatValue(FIELDS[1], fieldValue(snapshot, FIELDS[1]));
      var roundsText = formatValue(FIELDS[2], fieldValue(snapshot, FIELDS[2]));
      var countLow = formatValue(FIELDS[3], fieldValue(snapshot, FIELDS[3]));
      var countHigh = formatValue(FIELDS[4], fieldValue(snapshot, FIELDS[4]));
      var overrideText = overridden === 0 ? "全部使用默认值" : overridden + " 项已自定义";

      function pair(label, value) {
        return h("span", { key: label }, label, h("b", null, value));
      }

      return h(
        "div",
        { className: "mt-card" },
        h(
          "div",
          { className: "mt-head" },
          h("span", { className: "mt-title" }, "ModelTrace 模型指纹校验"),
          h("span", { className: "mt-ns" }, SETTINGS_NAMESPACE)
        ),
        h(
          "div",
          { className: "mt-summary" },
          pair("总开关：", enabledText),
          pair("不一致动作：", enforceText),
          pair("轮数：", roundsText),
          pair("数字个数：", countLow + "–" + countHigh),
          h("span", { className: "mt-dim" }, overrideText)
        ),
        h(StatusLine, { snapshot: snapshot, writable: snapshot.writable })
      );
    }

    function PageView(props) {
      var scope = props.scope;
      var snapshot = props.snapshot;
      var errorPair = React.useState(null);
      var error = errorPair[0];
      var setError = errorPair[1];

      function run(promise) {
        if (!promise || typeof promise.then !== "function") return;
        setError(null);
        promise.then(
          function () {
            setError(null);
          },
          function (reason) {
            setError(reason && reason.message ? reason.message : String(reason));
          }
        );
      }

      function commit(field, value) {
        if (!scope || typeof scope.set !== "function") return;
        run(scope.set(field, value));
      }

      function reset(field) {
        if (!scope || typeof scope.unset !== "function") return;
        run(scope.unset(field));
      }

      function resetAll() {
        for (var i = 0; i < FIELDS.length; i += 1) {
          if (isOverridden(snapshot, FIELDS[i])) reset(FIELDS[i].key);
        }
      }

      var overridden = FIELDS.filter(function (field) {
        return isOverridden(snapshot, field);
      }).length;

      return h(
        "div",
        { className: "mt-card" },
        h(
          "div",
          { className: "mt-head" },
          h("span", { className: "mt-title" }, "ModelTrace 模型指纹校验"),
          h("span", { className: "mt-ns" }, SETTINGS_NAMESPACE)
        ),
        h(StatusLine, { snapshot: snapshot, writable: snapshot.writable }),
        h("p", { className: "mt-hint" }, RULES),
        FIELDS.map(function (field) {
          return h(FieldRow, {
            key: field.key,
            field: field,
            snapshot: snapshot,
            disabled: props.busy === true,
            onCommit: function (value) {
              commit(field.key, value);
            },
            onReset: function () {
              reset(field.key);
            }
          });
        }),
        h(
          "div",
          { className: "mt-foot" },
          h("button", { type: "button", className: "mt-btn", disabled: overridden === 0, onClick: resetAll }, "全部重置为默认"),
          h("span", { className: "mt-dim" }, overridden === 0 ? "全部使用组装层默认值" : overridden + " 项来自 user 层覆盖")
        ),
        error === null ? null : h("p", { className: "mt-err" }, "\u26a0 写入失败：" + error)
      );
    }

    /** Card entry point. `view` is absent in the current shell, so both shapes render. */
    function ModelTraceCard(props) {
      var scope = props.scope;
      var snapshot = useScopeSnapshot(scope);
      if (props.view === "summary") return h(SummaryView, { snapshot: snapshot, scope: scope });
      return h(PageView, { snapshot: snapshot, scope: scope, busy: props.busy });
    }

    function resultStatus(result) {
      return result.status || (result.running ? "running" : result.verdict ? "complete" : "idle");
    }

    function confidence(value) {
      return typeof value === "number" && isFinite(value) ? (value * 100).toFixed(1) + "%" : "—";
    }

    // One request at a time. Each effect owns its timer and abort signal; a session
    // change disposes the old effect before its response can update this view.
    function ModelTraceWindow(props) {
      var snapshot = useScopeSnapshot(props.scope);
      var statePair = React.useState({ sessionId: props.sessionId, result: null, error: null });
      var state = statePair[0];
      var setState = statePair[1];
      var hiddenPair = React.useState(0);
      var redraw = hiddenPair[1];
      var enabled = fieldValue(snapshot, { key: "enabled" }) !== false;
      var floating = fieldValue(snapshot, { key: "floatingWindow" }) !== false;
      React.useEffect(function () {
        if (!props.sessionId || !enabled || !floating) return undefined;
        var stopped = false;
        var timer;
        var controller = new AbortController();
        setState({ sessionId: props.sessionId, result: null, error: null });
        async function poll() {
          var delay = 5000;
          try {
            var response = await fetch("/api/modeltrace?sessionId=" + encodeURIComponent(props.sessionId), {
              credentials: "same-origin", cache: "no-store", signal: controller.signal
            });
            if (!response.ok) throw new Error("ModelTrace HTTP " + response.status);
            var result = await response.json();
            if (!isObject(result)) throw new Error("ModelTrace 返回了无效结果");
            if (stopped) return;
            setState({ sessionId: props.sessionId, result: result, error: null });
            if (resultStatus(result) === "running") delay = 2000;
          } catch (error) {
            if (stopped) return;
            setState(function (previous) {
              return { sessionId: props.sessionId, result: previous.sessionId === props.sessionId ? previous.result : null,
                error: error && error.message ? error.message : String(error) };
            });
            // Missing optional backend and authentication failures should not hammer the host.
            delay = 10000;
          }
          if (!stopped) timer = setTimeout(poll, delay);
        }
        poll();
        return function () { stopped = true; controller.abort(); clearTimeout(timer); };
      }, [props.sessionId, enabled, floating]);
      if (!enabled || !floating || state.sessionId !== props.sessionId) return null;
      var result = state.result;
      if (!result || result.floatingWindow === false || result.enabled === false) return null;
      var status = resultStatus(result);
      if (status === "idle") return null;
      var runKey = String(result.runId || result.startedAt || result.at || "initial");
      if (dismissedRuns.get(props.sessionId) === runKey) return null;
      var verdict = result.verdict || {};
      var claimed = verdict.claimedModel || (result.selection && (result.selection.model || result.selection.modelId)) || "—";
      var candidates = Array.isArray(verdict.candidates) ? verdict.candidates.slice(0, 3) : [];
      var roundTop = Array.isArray(verdict.roundTop) ? verdict.roundTop : [];
      var error = state.error || verdict.error || result.error;
      return h("aside", { className: "mt-card mt-float", role: "region", "aria-label": "ModelTrace 校验结果", "data-run-id": runKey },
        h("div", { className: "mt-head" }, h("b", null, "ModelTrace"),
          h("button", { type: "button", className: "mt-close", "aria-label": "关闭本次校验结果", onClick: function () {
            dismissedRuns.set(props.sessionId, runKey);
            redraw(function (value) { return value + 1; });
          } }, "关闭")),
        h("p", { role: "status" }, status === "running" ? "正在校验…" : "校验完成"),
        h("p", null, "声称模型：", String(claimed)),
        h("p", null, "裁决：", String(verdict.status || "等待结果"), result.locked ? " · 任务已锁定" : "", result.action ? " · " + String(result.action) : ""),
        h("p", { className: "mt-dim" }, "前三候选"),
        candidates.length ? h("ol", null, candidates.map(function (item, index) {
          return h("li", { key: index }, String(item.displayName || item.model || "—"), " · ", confidence(item.probability));
        })) : h("p", { className: "mt-dim" }, "等待候选结果"),
        h("p", { className: "mt-dim" }, "每轮最高置信度"),
        roundTop.length ? h("ol", null, roundTop.map(function (item, index) {
          return h("li", { key: index }, "第 " + String(item.round === undefined ? index + 1 : item.round) + " 轮：", String(item.model || "—"), " · ", confidence(item.probability));
        })) : h("p", { className: "mt-dim" }, "等待轮次结果"),
        error ? h("p", { className: "mt-err", role: "alert" }, "错误：", String(error)) : null
      );
    }

    /* ------------------------------------------------------------------ *
     * Plugin
     * ------------------------------------------------------------------ */

    var name = NAME;

    /**
     * Deliberately empty: the shell creates one loader entry per manifest row and
     * aborts the whole web boot when an entry does not reach `active`
     * (`web boot: N entries did not activate`). Declaring services here would park
     * this entry until they appear, so the dependencies are taken with a nested
     * `ctx.inject`, which parks only the child fiber.
     */
    var inject = [];

    function apply(ctx) {
      injectStyles();
      ctx.inject(["slots", "configForms"], function (sctx) {
        var scope = sctx.configForms.get(SETTINGS_NAMESPACE);
        var Card = function ModelTraceCardEntry(props) {
          var merged = {};
          for (var key in props) {
            if (Object.prototype.hasOwnProperty.call(props, key)) merged[key] = props[key];
          }
          merged.scope = scope;
          return h(ModelTraceCard, merged);
        };
        // Registration effects are owned by this child fiber, so disposal is handled by
        // cordis; returning the disposer as well would risk a double dispose.
        sctx.effect(function () {
          return sctx.configForms.whileServed([SETTINGS_NAMESPACE], function () {
            var disposers = CARD_SLOTS.map(function (slot) {
              return sctx.slots.inject(slot, function () {
                return sctx.slots.register({ name: slot, id: SETTINGS_NAMESPACE, order: 100, label: "ModelTrace" }, Card);
              });
            });
            return function () { disposers.forEach(function (dispose) { dispose(); }); };
          });
        });
        sctx.slots.inject(RESULT_SLOT, function () {
          return sctx.slots.register({ name: RESULT_SLOT, id: SETTINGS_NAMESPACE, order: 100,
            inject: function (sessionId) { return { sessionId: sessionId, scope: scope }; }
          }, ModelTraceWindow);
        });
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    exports.ModelTraceCard = ModelTraceCard;
    exports.ModelTraceWindow = ModelTraceWindow;
    exports.FIELDS = FIELDS;
    exports.DEFAULTS = DEFAULTS;
    exports.SETTINGS_NAMESPACE = SETTINGS_NAMESPACE;
    return module.exports;
  }
});
