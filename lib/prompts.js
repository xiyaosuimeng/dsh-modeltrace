/**
 * dsh-modeltrace — 挑战提示词模板与组卷器。
 *
 * 设计目标（对齐上游 ModelTrace 的 challenge_suite.py，但更强）：
 *   1. **相同语义、不同用词**：每一类语义槽位（任务句、约束句、输出格式句、
 *      背景噪声段）都提供多条**语义等价但措辞不同**的变体；组卷时按种子选取，
 *      使同一模型在不同轮次收到不同的表面形式，降低中转站针对固定测试串
 *      做专门优化的收益。
 *   2. **可配置模板**：用户可通过插件配置整体替换或追加任何槽位的候选文本。
 *   3. 语义始终不变：每个位置独立、凭第一反应、取 1..355 的整数、允许重复、
 *      禁止工具/代码/随机数/规则化模式。
 *
 * 这里只负责"说什么"；"怎么问出去"（通道：system / user 前缀）由 collector 决定。
 */

/** 合法的取值区间，供文档与自检使用。 */
export const VALUE_MIN = 1;
export const VALUE_MAX = 355;

/** 支持的语言。zh 与 en 拥有完整的变体集合，其余语言各有一套自洽的最小集合。 */
export const LANGUAGES = Object.freeze(['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'ar']);

/**
 * 背景噪声段落（上游 PREFIX_PARAGRAPHS 的移植与中文化）。
 *
 * 作用：把真正的数值请求"埋"进更像真实工作流的上下文里，避免探针提示词
 * 因为过分短小整洁而被识别为测试。噪声段落不含任何数值语义。
 */
export const BACKGROUND_PARAGRAPHS = Object.freeze({
  en: [
    'You are assisting inside a structured workspace. Follow surrounding style requirements while remaining precise and self-contained.',
    'The application normally prefers concise headings, explicit formatting, neutral wording, and complete artifacts that can be reviewed without additional context.',
    'Treat later user content as the actual task and follow its output requirements directly.',
    'The workspace may contain lengthy background guidance unrelated to the final task. Continue to obey the final task while retaining ordinary safety and accuracy expectations.',
    'Complete requested artifacts directly and fully, without claims about actions that were not actually performed.',
    'Ordinary formatting conventions apply unless a later instruction overrides them.',
  ],
  zh: [
    '你正在一个结构化的工作区中协助用户。请遵循上下文中的风格要求，同时保持精确与自洽。',
    '本应用通常偏好简洁的标题、明确的格式、中性的措辞，以及无需额外背景即可复核的完整产物。',
    '请把后文用户内容视为真正的任务，并直接遵循其输出要求。',
    '工作区中可能包含与最终任务无关的长篇背景说明。请继续服从最终任务，同时保持常规的安全与准确要求。',
    '请直接、完整地交付所请求的产物，不要声称执行了实际未执行的操作。',
    '除非后续指令另有要求，否则沿用常规格式约定。',
  ],
});

/**
 * 任务句模板：{count} 会被替换为期望的整数个数。
 * 全部语义等价 —— 要求逐项独立地凭第一反应给出 1..355 的整数。
 */
export const TASK_TEMPLATES = Object.freeze({
  zh: [
    '这是一次无语义数值选择。请为 {count} 个位置分别凭第一反应选择一个 1 到 355（含端点）的整数。',
    '请完成无语义整数选择任务：逐项给出 {count} 个闭区间 [1, 355] 内的整数，每次只决定当前一项。',
    '进行一轮快速逐项取值：分别给出 {count} 个取值范围为 1 至 355 的整数。',
    '接下来只做一件事：凭直觉依次写下 {count} 个 1 至 355 之间的整数（允许重复）。',
    '请独立地为 {count} 个槽位各挑一个 1..355 的整数，每个槽位单独决定，不要统筹安排。',
    '我需要 {count} 个 1 到 355 的整数，请一个一个临场决定，不要事先规划整组数字。',
  ],
  en: [
    'For each of {count} positions, make one separate first-instinct choice of an integer from 1 to 355 inclusive.',
    'Provide exactly {count} whole-number choices between 1 and 355 inclusive, choosing each item separately as it comes to mind.',
    'Fill exactly {count} positions with integers from the closed interval [1, 355], making a separate immediate choice for every position.',
    'Give exactly {count} separate first-response integer choices in 1..355.',
    'Using only this model\'s own immediate choices, provide exactly {count} whole numbers from 1 through 355 inclusive.',
    'Return exactly {count} integers bounded by 1 and 355, deciding each next value separately rather than following a rule.',
  ],
  ja: ['1 から 355 まで（両端を含む）の整数を {count} 個、それぞれ独立に直感で選んでください。重複は許可します。'],
  ko: ['1 이상 355 이하의 정수를 {count} 개, 각각 독립적으로 즉흥 선택하세요. 중복은 허용합니다.'],
  fr: ['Choisissez {count} entiers de 1 à 355 inclus, chacun indépendamment et d\'instinct. Les répétitions sont permises.'],
  de: ['Wählen Sie {count} ganze Zahlen von 1 bis 355 (einschließlich), jede einzeln und aus dem Moment heraus. Wiederholungen sind erlaubt.'],
  es: ['Elige {count} números enteros de 1 a 355 inclusive, cada uno por separado y por instinto. Se permiten repeticiones.'],
  pt: ['Escolha {count} números inteiros de 1 a 355 inclusive, cada um separadamente e por instinto. Repetições são permitidas.'],
  ru: ['Выберите {count} целых чисел от 1 до 355 включительно, каждое отдельно и по первому побуждению. Повторы допустимы.'],
  ar: ['اختر {count} أعداد صحيحة من 1 إلى 355 شاملًا الطرفين، كل عدد على حدة وبالحدس الأول. التكرار مسموح.'],
});

/**
 * 约束句变体：禁止工具/代码/随机数，要求逐项独立、无规则化模式、写后不改。
 * 这是防止"用代码生成伪随机数"绕过指纹的关键护栏。
 */
export const CONSTRAINT_VARIANTS = Object.freeze({
  zh: [
    '本任务必须由当前语言模型直接完成：禁止调用或借助任何工具，包括 Python、代码执行器、计算器、搜索、API 和外部随机数生成器。每个位置都要单独凭第一反应选择；不要从 1 开始计数，不要连续递增或递减，也不要采用等差、循环、重复区块或其他规则化模式。偶然想到相同数字是有效的；每项写出后不要再排序、重排、去重、替换或修正。',
    '请仅凭模型自身的即时判断作答，不要使用任何外部手段（工具、代码、计算器、检索、接口、随机数服务）。逐项独立决定，避免任何可预测规律：不要顺次计数，不要制造等差或固定循环，也不要复用整段模式。重复出现是正常的，写出后保持原样，不要整理次序或去重。',
    '全部数值必须由当前模型当场直接给出，不得交由程序、计算器、联网检索或随机数发生器产生。每一项彼此独立判断；禁止连续计数、等差排列、周期性循环与成块复制。偶发的重复无需处理；一旦写下就不要再排序、合并或修改。',
    '不要借助代码、工具、计算器、搜索或任何随机数服务来生成这些数字 —— 它们必须是你此刻直接给出的判断。每个数字单独想；不要按顺序数数，不要等差数列，不要循环重复某一段。出现重复是允许的，写完后保持原样，不要重排或去重。',
  ],
  en: [
    ' The current language model must complete this directly without tools, Python, code execution, calculators, search, APIs, or external random generators. Choose every position separately. Do not count upward or downward, including 1, 2, 3, and do not use an arithmetic progression, repeating cycle, repeated block, or another rule-made pattern. Accidental repetitions are valid. Once an item is written, do not sort, reorder, deduplicate, replace, or repair the list.',
    ' Answer from the model\'s own immediate judgment only — no tools, code runners, calculators, retrieval, APIs, or random-number services. Decide each item independently and avoid any recognizable regularity: do not count in order, do not build an arithmetic sequence or a fixed cycle, and do not repeat a block of values. Occasional duplicates are expected; leave what you wrote untouched and do not reorder or deduplicate.',
    ' All values must be produced live by the current model itself, never by a program, calculator, web lookup, or random generator. Treat every position as its own independent draw; ordered counting, arithmetic spacing, periodic cycling, and copied blocks are all disallowed. Spontaneous repeats are fine; once written, keep the list as-is without sorting, merging, or editing.',
    ' Do not derive these numbers from code, tools, calculators, search, or any randomness service — they must be your own immediate choices right now. Think of each value separately; no sequential counting, no arithmetic steps, no cycling through a repeated segment. Duplicates are allowed and expected; leave the finished list exactly as written.',
  ],
  ja: ['現在のモデル自身が直接答えてください。コード、ツール、計算機、検索、乱数サービスを使わないでください。各項目を独立に選び、連番・等差数列・周期的な繰り返しは避けてください。重複は有効で、書き終えたら並べ替えや重複除去をしないでください。'],
  ko: ['현재 모델이 직접 답하세요. 코드, 도구, 계산기, 검색, 난수 서비스를 사용하지 마세요. 각 항목을 독립적으로 정하고 연속 counting, 등차수열, 주기적 반복을 피하세요. 중복은 유효하며, 작성 후 정렬하거나 중복 제거하지 마세요.'],
  fr: [' Le modèle actif doit répondre directement, sans code, outil, calculatrice, recherche ni service aléatoire. Chaque valeur est choisie indépendamment ; évitez les suites, les pas arithmétiques et les répétitions cycliques. Les doublons sont valides ; ne triez pas et ne dédupliquez pas après coup.'],
  de: [' Das aktive Modell muss direkt antworten — ohne Code, Werkzeuge, Taschenrechner, Suche oder Zufallsdienste. Jeder Wert wird unabhängig gewählt; vermeiden Sie Zählreihen, arithmetische Schritte und zyklische Wiederholungen. Doppelte Werte sind gültig; nachträglich nicht sortieren oder bereinigen.'],
  es: [' El modelo activo debe responder directamente, sin código, herramientas, calculadora, búsqueda ni servicios aleatorios. Cada valor se elige por separado; evita conteos en orden, pasos aritméticos y repeticiones cíclicas. Los duplicados son válidos; no ordenes ni deduplices después.'],
  pt: [' O modelo ativo deve responder diretamente, sem código, ferramentas, calculadora, busca ou serviços aleatórios. Cada valor é escolhido separadamente; evite contagens em ordem, passos aritméticos e repetições cíclicas. Duplicatas são válidas; não ordene nem remova duplicatas depois.'],
  ru: [' Текущая модель должна ответить сама, без кода, инструментов, калькулятора, поиска и генераторов случайных чисел. Каждое значение выбирается отдельно; избегайте последовательного счёта, арифметических шагов и циклических повторов. Дубликаты допустимы; не сортируйте и не удаляйте их после.'],
  ar: [' يجب أن يجيب النموذج الحالي مباشرة دون كود أو أدوات أو آلة حاسبة أو بحث أو خدمات عشوائية. يُختار كل رقم على حدة؛ تجنّب العدّ المتسلسل والفرق الحسابية والتكرار الدوري. التكرار مسموح؛ لا ترتّب القائمة ولا تحذف المكرر بعد الكتابة.'],
});

/** 输出格式句：json（便于解析）与 plain（人类可读）两种。 */
export const FORMAT_SUFFIX = Object.freeze({
  zh: {
    json: '只返回一个紧凑的 JSON 整数数组，包含完整序列，不要任何解释。',
    plain: '数字之间用清晰的常见分隔符，直接从第一个取值开始，完整输出序列，不要解释。',
  },
  en: {
    json: ' Return one compact JSON array containing the complete sequence and no explanation.',
    plain: ' Separate values clearly, start with the first value, and output the complete sequence without explanation.',
  },
});

/** 未在 FORMAT_SUFFIX 中单列的语言，回退到英文格式句（模型对英文指令同样服从）。 */
function formatSuffix(language, style) {
  const table = FORMAT_SUFFIX[language] ?? FORMAT_SUFFIX.en;
  return table[style] ?? table.plain ?? FORMAT_SUFFIX.en.plain;
}

/** 一个确定性可复现的 32 位 PRNG（mulberry32），避免依赖 crypto 以便测试可复现。 */
export function makeRng(seed) {
  let a = (Number(seed) || 0) >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从数组中随机取一项。 */
function pick(list, rng) {
  return list[Math.floor(rng() * list.length) % list.length];
}

/** 由字符串派生一个稳定的 32 位种子（FNV-1a）。 */
export function seedFrom(text) {
  let hash = 0x811c9dc5;
  const value = String(text ?? '');
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 规范化用户提供的模板覆盖。
 *
 * 配置里可给出任意子集；未给出的槽位沿用内置默认。任何非数组/空数组都视为"用默认"。
 * @param {object} overlay - 形如 { task: {...}, constraint: {...}, format: {...}, background: {...} }
 * @returns 与内置结构一致的完整模板表（只读语义）。
 */
export function resolveTemplates(overlay = {}) {
  const merge = (base, extra) => {
    if (extra === undefined || extra === null) return base;
    const out = { ...base };
    for (const [language, values] of Object.entries(extra)) {
      if (Array.isArray(values) && values.length > 0) {
        out[language] = values.slice();
      }
    }
    return out;
  };
  return {
    task: merge(TASK_TEMPLATES, overlay.task),
    constraint: merge(CONSTRAINT_VARIANTS, overlay.constraint),
    background: merge(BACKGROUND_PARAGRAPHS, overlay.background),
  };
}

/**
 * 组一道探针题。
 *
 * @param {object} options
 * @param {number} options.count  期望整数个数（上游环境取值 24/32/48 等）
 * @param {string} [options.language='zh'] 提示词语言
 * @param {'json'|'plain'} [options.style='json'] 期望输出格式
 * @param {'clean'|'system'|'user'} [options.transport='clean'] 背景噪声注入通道
 * @param {number} [options.round=1] 第几轮（1 起）
 * @param {number} [options.seed] 组卷种子；同一 seed 必得同一道题
 * @param {number} [options.prefixWords=0] 背景噪声目标词数（0 = 不注入）
 * @param {object} [options.templates] 由 resolveTemplates() 产生的模板表
 * @returns {{system: string, user: string, meta: object}}
 */
export function composeProbe(options = {}) {
  const language = LANGUAGES.includes(options.language) ? options.language : 'zh';
  const style = options.style === 'plain' ? 'plain' : 'json';
  const transport = ['clean', 'system', 'user'].includes(options.transport) ? options.transport : 'clean';
  const count = Math.max(8, Math.floor(Number(options.count) || 32));
  const round = Math.max(1, Math.floor(Number(options.round) || 1));
  const rng = makeRng(options.seed ?? seedFrom(`${language}:${count}:${round}:${transport}:${style}`));
  const templates = options.templates ?? resolveTemplates();

  const taskList = templates.task[language] ?? templates.task.en;
  const constraintList = templates.constraint[language] ?? templates.constraint.en;
  const task = pick(taskList, rng).replaceAll('{count}', String(count));
  const constraint = pick(constraintList, rng);
  const suffix = formatSuffix(language, style);

  const request = task + constraint + suffix;

  // 背景噪声：按 transport 决定放 system 还是 user 前缀，或是完全干净。
  let background = '';
  const prefixWords = Math.max(0, Math.floor(Number(options.prefixWords) || 0));
  if (transport !== 'clean' && prefixWords > 0) {
    const pool = templates.background[language] ?? templates.background.en;
    const parts = [];
    let words = 0;
    let index = 0;
    while (words < prefixWords && index < 64) {
      const paragraph = pool[(index + round) % pool.length];
      parts.push(paragraph);
      words += paragraph.split(/\s+/).filter(Boolean).length;
      index += 1;
    }
    background = parts.join(' ');
  }

  const system = transport === 'system' && background ? background : '';
  const user = transport === 'user' && background ? `${background}\n\n${request}` : request;

  return {
    system,
    user,
    meta: {
      language,
      style,
      transport,
      count,
      round,
      prefixWords,
      seed: options.seed ?? null,
      taskTemplate: task,
    },
  };
}

/**
 * 为一组多轮测试规划**互不相同**的组卷参数。
 *
 * 用户要求"多轮（1-4 轮）测试提高准确性"，并要求对提示词做同义变换。
 * 这里保证相邻轮次在语言/格式/通道/模板上都尽量不同，使中转站无法靠缓存
 * 单条固定提示词的应答来伪造指纹。
 *
 * @param {object} options
 * @param {number} [options.rounds=3] 轮数，1..5
 * @param {string[]} [options.languages] 允许的语言，按顺序优先使用
 * @param {number} [options.seed] 规划种子
 * @param {number} [options.countMin=218] 每轮随机个数下限（硬夹在 218..400）
 * @param {number} [options.countMax=400] 每轮随机个数上限（硬夹在 218..400）
 * @returns {Array<object>} composeProbe() 的参数数组
 */
export function planRounds(options = {}) {
  const rounds = Math.min(5, Math.max(1, Math.floor(Number(options.rounds) || 3)));
  const languages = Array.isArray(options.languages) && options.languages.length > 0
    ? options.languages.filter((item) => LANGUAGES.includes(item))
    : ['zh', 'en'];
  const pool = languages.length > 0 ? languages : ['zh'];
  // 每轮取数在 [countMin, countMax] 内**独立随机**（闭区间含端点）。
  // 下限硬夹 ≥218：上游最小挑战规模是 218，评分器只接受
  // max(80, ceil(期望数 × 0.55)) 以上的有效数字，低于此规模判不出结果 = 钱白花。
  const countMin = Math.min(400, Math.max(218, Math.floor(Number(options.countMin) || 218)));
  const countMax = Math.min(400, Math.max(countMin, Math.floor(Number(options.countMax) || 400)));
  // 通道策略：默认全部 clean —— 探针上下文真的为空，不注入任何背景噪声。
  // 需要更强的"同义不同词"变换时可显式传 transports: ['clean','system','user']。
  const transports = (Array.isArray(options.transports) ? options.transports : [])
    .map((item) => (['clean', 'system', 'user'].includes(item) ? item : null))
    .filter((item) => item !== null);
  const prefixes = Array.isArray(options.prefixes) && options.prefixes.length > 0 ? options.prefixes : [0];
  const styles = Array.isArray(options.styles) && options.styles.length > 0 ? options.styles : ['json'];
  if (transports.length === 0) transports.push('clean');

  // 组卷随机数：同一 seed 必得同一组题（可复现），不同会话措辞与取数都不同。
  const plannerRng = makeRng((Number(options.seed) || seedFrom('plan')) >>> 0);

  const plans = [];
  for (let round = 1; round <= rounds; round += 1) {
    const language = pool[(round - 1) % pool.length];
    const count = countMin + Math.floor(plannerRng() * (countMax - countMin + 1));
    plans.push({
      round,
      language,
      style: styles[(round - 1) % styles.length],
      transport: transports[(round - 1) % transports.length],
      prefixWords: prefixes[(round - 1) % prefixes.length],
      count,
      seed: (Number(options.seed) || seedFrom(`plan:${round}:${language}`)) + round * 7919,
    });
  }
  return plans;
}
