// Every text on the page, English first, Chinese second. t(key, vars) fills {name}
// placeholders; a key with `_one` / `_other` variants picks one by vars.n (English plurals;
// Chinese uses `_other` only).
const STRINGS = {
  en: {
    title: 'Lite Player usage',
    subtitle: 'Anonymous usage data, totals only',
    range: 'Range', range_7: '7 days', range_30: '30 days', range_90: '90 days',
    rangeLong: 'the last {n} days', prevLong: 'the {n} days before',
    version: 'Version', allVersions: 'All versions',
    excludeMine: 'Exclude my devices', excludeMineHint: 'Leaves out the devices listed in OWNER_UIDS',
    language: 'Language', theme: 'Theme', themeSystem: 'System theme', themeLight: 'Light theme', themeDark: 'Dark theme',
    asOf: 'Newest data {time}', noDataYet: 'No data received yet',
    loading: 'Loading', loadFailed: 'Could not load the data ({status}). Reload the page; if it keeps failing, sign in again.',
    retry: 'Try again',
    status_good: 'Fine', status_warn: 'Worth a look', status_bad: 'Needs attention', status_none: 'No data', status_info: '',
    lowSample: 'Few data',
    basedOn_users_one: 'Based on {n} user', basedOn_users_other: 'Based on {n} users',
    basedOn_views_one: 'Based on {n} viewing', basedOn_views_other: 'Based on {n} viewings',
    basedOn_devices_one: 'Based on {n} device', basedOn_devices_other: 'Based on {n} devices',
    basedOn_loads_one: 'Based on {n} page load', basedOn_loads_other: 'Based on {n} page loads',
    tooFew: 'Too few to judge',
    fewTail_one: 'Only {n} so far, so read this as a hint.', fewTail_other: 'Only {n} so far, so read this as a hint.',
    showTable: 'Show as table', showChart: 'Show as chart',
    unknown: 'Unknown', other: 'Other',

    // Overview
    tile_users: 'Active users', tile_devices: 'Most common setup', tile_smooth: 'Smoothness',
    tile_errors: 'Viewings with problems', tile_features: 'Features in use', tile_compat: 'Echo360 compatibility',
    users_one: '{n} user', users_other: '{n} users',
    views_one: '{n} viewing', views_other: '{n} viewings', ofViews_one: 'of {n} viewing', ofViews_other: 'of {n} viewings',
    hoursWatched: '{h} watched',
    vsPrev: 'vs {prev}', deltaSame: 'same as {prev}',
    newUsers_one: '{n} new', newUsers_other: '{n} new',
    setupOn: '{browser} on {os}', setupShares: '{browser} on {b} of devices, {os} on {o}',
    droppedFrames: 'dropped frames', inputP90: 'Slowest 10% of clicks: {v}',
    problemsTop: 'Most often: {what}', problemsNone: 'Nothing failed',
    featuresOf: '{used} of {total}', featuresTop: 'Most used: {list}',
    fallbackShare: 'fell back', compatNew_one: 'Echo360 page code changed {when}', compatNew_other: 'Echo360 page code changed {n} times recently',
    compatSame: 'No change in Echo360 page code this week',
    noUsersHint: 'Nobody in this range. Try 90 days, or include your own devices.',
    nothingYet: 'No usage data has arrived yet. It shows up here once someone watches a recording with the Lite Player and usage data turned on.',

    // Sections
    sec_users: 'Users', sec_devices: 'Devices', sec_smooth: 'Performance', sec_errors: 'Stability', sec_features: 'Features', sec_compat: 'Echo360 compatibility',
    find_users_none: 'Nobody used the player in {range}.',
    find_users: '{users} used the player in {range}, with {views} and {hours} of playback.',
    find_users_delta: '{delta} than {prev}.',
    more: '{n} more', fewer: '{n} fewer', same: 'The same number as',
    find_devices_none: 'No device reports in {range}.',
    find_devices: 'Most people use {setup}. {touch} of devices have a touch screen.',
    find_devices_one: 'The one device in this range runs {setup}.',
    find_smooth_none: 'No viewings of a minute or more in {range}, so nothing to measure yet.',
    find_smooth_good: 'Playback is smooth: median dropped frames {dropped}, and 9 in 10 clicks are answered within {input}.',
    find_smooth_warn: 'Mostly smooth, but {what} is above its limit.',
    find_smooth_warn_many: 'Mostly smooth, but {what} are above their limits.',
    find_smooth_bad: 'The player is straining computers: {what} is well above its limit.',
    find_smooth_bad_many: 'The player is straining computers: {what} are well above their limits.',
    find_errors_none: 'No viewings in {range}.',
    find_errors: '{pct} of viewings had a problem ({n}).',
    find_errors_clean: 'No viewing had a problem in {range}.',
    find_features_none: 'No viewings in {range}.',
    find_features: '{used} of {total} features were used. {unused} were never used.',
    find_compat_none: 'No page loads in {range}.',
    find_compat: '{pct} of page loads went to the original player without the user asking ({n}).',
    find_compat_clean: 'Every page load in {range} kept the Lite Player, unless the user asked otherwise.',
    find_compat_new: 'Echo360 page code new since {date}: {fallbacks} on it.',

    // Users section
    dailyUsers: 'Daily active users', dailyUsersCap: 'People with any activity each day',
    versionsInUse: 'Script version in use', whereFrom: 'Where from', country: 'Country', region: 'Region', network: 'Network',
    watchedShare: 'Average share of a recording watched', silenceSkipped: 'Silence skipped', newInRange: 'New users',
    keysShare: 'Commands given by keyboard',
    tipUsers: 'active users', tipViews: 'viewings', tipPlayed: 'played',

    // Devices
    dim_browser: 'Browser', dim_os: 'System', dim_manager: 'Script manager', dim_form: 'Device type', dim_screen: 'Screen width',
    dim_cores: 'CPU cores', dim_memory: 'Memory', dim_gpu: 'Graphics', dim_hwdecode: '1080p video decoding', dim_webgpu: 'WebGPU',
    form_desktop: 'Desktop', form_touch: 'Touch screen', form_phone: 'Phone or tablet',
    screen_s: 'Under 768 px', screen_m: '768 to 1279 px', screen_l: '1280 to 1919 px', screen_xl: '1920 px or wider',
    memory_lt4: 'Under 4 GB', memory_4: '4 to 7 GB', memory_8: '8 GB or more',
    hwdecode_yes: 'Hardware', hwdecode_no: 'Software only', webgpu_yes: 'Available', webgpu_no: 'Not available',
    cores_n: '{v} cores',

    // Performance
    perfIntro: 'Median and slowest 10% across viewings with at least a minute of playback. The line marks the limit.',
    smoothness: 'Smoothness', startup: 'Start and seeking', load: 'Load on the computer',
    m_dropped_pct: 'Dropped frames', m_input_ms90: 'Click response (slowest 10%)', m_long_tasks_pm: 'Long tasks per minute',
    m_heap_mb: 'Memory used', m_first_frame_ms: 'Time to first picture', m_ready_ms: 'Time until controls work',
    m_seek_ms90: 'Seeking (slowest 10%)', m_rebuffer_pct: 'Time spent buffering', m_sync_ms_max: 'Largest drift between views',
    m_boot_ms: 'Script start to player shown', m_cpu_bg: 'CPU strained, analyses running', m_cpu_idle: 'CPU strained, no analyses',
    median: 'median', p90: 'slowest 10%', p90Is: 'median; slowest 10% {v}', limit: 'limit {v}', noMeasure: 'Not measured yet',
    byVersion: 'By version', versionCol: 'Version', viewingsCol: 'Viewings',

    // Stability
    dailyProblems: 'Viewings with a problem', dailyProblemsCap: 'Per day; errors reported shown on hover',
    tipProblems: 'with a problem', tipErrors: 'errors reported',
    kinds: 'What went wrong', k_uncaught: 'Uncaught script error', k_featureOff: 'Feature turned off',
    k_stream: 'Video stream error', k_request: 'A request failed', k_renew: 'Access renewal failed', k_send: 'Usage data not sent',
    topErrors: 'Most frequent errors', errFeature: 'Feature', errMessage: 'Error', errTimes: 'Times', errUsers: 'Users', errVersions: 'Versions', errLast: 'Last seen',
    noErrors: 'No errors reported in this range.',
    failedParts: 'Failures by part', kind_feature_off: 'Turned off', kind_request: 'Request', kind_stream: 'Stream',

    // Features
    featureUse: 'Share of users who used each feature', neverUsed: 'Never used in this range',
    changedSettings: 'Settings changed from the default', speedsPlayed: 'Playback time by speed', speedX: '{v}×',
    noneChanged: 'Nobody changed a setting.',

    // Compatibility
    dailyFallbacks: 'Pages sent to the original player', dailyFallbacksCap: 'Per day, not counting the user asking for it',
    tipFallbacks: 'sent to the original player',
    pageCode: 'Echo360 page code versions', pageCodeCap: 'The names of Echo360’s script files. A new one means Echo360 changed its player.',
    firstSeen: 'first seen {when}', pageViews: '{v} viewings', pageFallbacks_one: '{n} fallback', pageFallbacks_other: '{n} fallbacks',
    reasons: 'Why pages went to the original player', bootPaths: 'How the script started',
    boot_intercept: 'Caught the page’s player before it started', boot_takeover: 'Took over a player already running',
    boot_fallback: 'Left the page to the original player', bootMedian: 'median {v} to show the player',
    chosen: 'chosen by the user',
    r_startFailed: 'Player failed to start', r_noHls: 'Browser cannot play the stream', r_noBootstrap: 'Page never started its player the known way',
    r_coreError: 'Unexpected error while playing', r_playbackError: 'Video stopped with an error', r_auth: 'Sign-in expired',
    r_user: 'User switched', r_extras: 'Opened polls or other original-only parts', r_attachment: 'Opened a discussion attachment',
    r_unsupported: 'Recording type not supported', r_libFailed: 'Video library failed to load', r_noBootData: 'Start-up data not found on the page',
    noFallbacks: 'No page went to the original player in this range.',
    noFrontends: 'No Echo360 page code seen in this range.',

    footer: 'Read-only. Shows totals only: no user ids and nothing per person. Filters apply to every number on the page.',
  },
  zh: {
    title: 'Lite Player 使用情况',
    subtitle: '匿名使用数据，仅汇总',
    range: '时间范围', range_7: '7 天', range_30: '30 天', range_90: '90 天',
    rangeLong: '近 {n} 天', prevLong: '之前 {n} 天',
    version: '版本', allVersions: '全部版本',
    excludeMine: '排除我的设备', excludeMineHint: '不计 OWNER_UIDS 里列出的设备',
    language: '语言', theme: '主题', themeSystem: '跟随系统', themeLight: '浅色', themeDark: '深色',
    asOf: '最新数据 {time}', noDataYet: '还没有收到数据',
    loading: '加载中', loadFailed: '数据加载失败（{status}）。请刷新页面；一直失败的话请重新登录。',
    retry: '重试',
    status_good: '正常', status_warn: '值得留意', status_bad: '需要处理', status_none: '暂无数据', status_info: '',
    lowSample: '数据很少',
    basedOn_users_other: '基于 {n} 位用户', basedOn_views_other: '基于 {n} 次观看', basedOn_devices_other: '基于 {n} 台设备', basedOn_loads_other: '基于 {n} 次页面加载',
    tooFew: '样本太少，仅供参考',
    fewTail_other: '目前只有 {n} 次，仅供参考。',
    showTable: '以表格显示', showChart: '以图表显示',
    unknown: '未知', other: '其他',

    tile_users: '活跃用户', tile_devices: '最常见的设备', tile_smooth: '流畅度',
    tile_errors: '出问题的观看', tile_features: '在用的功能', tile_compat: 'Echo360 兼容性',
    users_other: '{n} 人', views_other: '{n} 次观看', ofViews_other: '（共 {n} 次观看）',
    hoursWatched: '观看 {h}',
    vsPrev: '对比{prev}', deltaSame: '与{prev}持平',
    newUsers_other: '新增 {n} 人',
    setupOn: '{os} 上的 {browser}', setupShares: '{browser} 占设备的 {b}，{os} 占 {o}',
    droppedFrames: '掉帧', inputP90: '最慢 10% 的点击：{v}',
    problemsTop: '最常见：{what}', problemsNone: '没有出错',
    featuresOf: '{used} / {total}', featuresTop: '用得最多：{list}',
    fallbackShare: '退回原播放器', compatNew_other: 'Echo360 页面代码{when}有变化',
    compatSame: '本周 Echo360 页面代码没有变化',
    noUsersHint: '这段时间没有人用。可以换成 90 天，或者把自己的设备也算进来。',
    nothingYet: '还没有收到任何使用数据。有人开着使用数据用 Lite Player 看录像后，这里就会出现数据。',

    sec_users: '用户', sec_devices: '设备', sec_smooth: '性能', sec_errors: '稳定性', sec_features: '功能', sec_compat: 'Echo360 兼容性',
    find_users_none: '{range}没有人使用播放器。',
    find_users: '{range}有 {users}使用播放器，共 {views}，播放 {hours}。',
    find_users_delta: '比{prev}{delta}。',
    more: '多 {n} 人', fewer: '少 {n} 人', same: '人数与之相同：',
    find_devices_none: '{range}没有设备信息。',
    find_devices: '大多数人用 {setup}。{touch} 的设备有触摸屏。',
    find_devices_one: '这段时间唯一的设备是 {setup}。',
    find_smooth_none: '{range}没有超过一分钟的观看，暂时无法衡量。',
    find_smooth_good: '播放流畅：掉帧中位数 {dropped}，九成点击在 {input} 内响应。',
    find_smooth_warn: '大体流畅，但{what}超过了限值。',
    find_smooth_warn_many: '大体流畅，但{what}超过了限值。',
    find_smooth_bad_many: '播放器让电脑吃力：{what}远超限值。',
    find_smooth_bad: '播放器让电脑吃力：{what}远超限值。',
    find_errors_none: '{range}没有观看。',
    find_errors: '{pct} 的观看出过问题（{n}）。',
    find_errors_clean: '{range}所有观看都没有出问题。',
    find_features_none: '{range}没有观看。',
    find_features: '{total} 个功能中有 {used} 个被用过，{unused} 个从没用过。',
    find_compat_none: '{range}没有页面加载。',
    find_compat: '{pct} 的页面在用户没要求的情况下退回了原播放器（{n}）。',
    find_compat_clean: '{range}所有页面都保持在 Lite Player，除非用户自己要求切换。',
    find_compat_new: '自 {date} 起出现了新的 Echo360 页面代码，期间 {fallbacks}。',

    dailyUsers: '每日活跃用户', dailyUsersCap: '每天有任何活动的人数',
    versionsInUse: '正在用的脚本版本', whereFrom: '来自哪里', country: '国家', region: '地区', network: '网络',
    watchedShare: '平均看完录像的比例', silenceSkipped: '跳过的静音', newInRange: '新用户',
    keysShare: '用键盘下达的操作',
    tipUsers: '活跃用户', tipViews: '次观看', tipPlayed: '播放时长',

    dim_browser: '浏览器', dim_os: '系统', dim_manager: '脚本管理器', dim_form: '设备类型', dim_screen: '屏幕宽度',
    dim_cores: 'CPU 核数', dim_memory: '内存', dim_gpu: '显卡', dim_hwdecode: '1080p 视频解码', dim_webgpu: 'WebGPU',
    form_desktop: '桌面', form_touch: '触摸屏', form_phone: '手机或平板',
    screen_s: '小于 768 px', screen_m: '768–1279 px', screen_l: '1280–1919 px', screen_xl: '1920 px 及以上',
    memory_lt4: '小于 4 GB', memory_4: '4–7 GB', memory_8: '8 GB 及以上',
    hwdecode_yes: '硬件', hwdecode_no: '仅软件', webgpu_yes: '可用', webgpu_no: '不可用',
    cores_n: '{v} 核',

    perfIntro: '统计至少播放一分钟的观看：中位数和最慢的 10%。竖线是限值。',
    smoothness: '流畅度', startup: '启动和跳转', load: '电脑负载',
    m_dropped_pct: '掉帧', m_input_ms90: '点击响应（最慢 10%）', m_long_tasks_pm: '每分钟长任务',
    m_heap_mb: '内存占用', m_first_frame_ms: '出现第一帧', m_ready_ms: '控件可用',
    m_seek_ms90: '跳转（最慢 10%）', m_rebuffer_pct: '缓冲时间占比', m_sync_ms_max: '两路画面最大偏差',
    m_boot_ms: '脚本启动到显示播放器', m_cpu_bg: 'CPU 吃紧（后台分析中）', m_cpu_idle: 'CPU 吃紧（无后台分析）',
    median: '中位数', p90: '最慢 10%', p90Is: '中位数；最慢 10% 为 {v}', limit: '限值 {v}', noMeasure: '还没有测量数据',
    byVersion: '按版本', versionCol: '版本', viewingsCol: '观看',

    dailyProblems: '出问题的观看', dailyProblemsCap: '每天；悬停可看报告的错误数',
    tipProblems: '次出问题', tipErrors: '个错误报告',
    kinds: '出了什么问题', k_uncaught: '脚本未捕获的错误', k_featureOff: '功能自动关闭',
    k_stream: '视频流错误', k_request: '请求失败', k_renew: '视频访问续期失败', k_send: '使用数据未发出',
    topErrors: '最常见的错误', errFeature: '功能', errMessage: '错误', errTimes: '次数', errUsers: '人数', errVersions: '版本', errLast: '最近一次',
    noErrors: '这段时间没有报告错误。',
    failedParts: '按部分统计的失败', kind_feature_off: '已关闭', kind_request: '请求', kind_stream: '视频流',

    featureUse: '用过各功能的用户比例', neverUsed: '这段时间没人用过',
    changedSettings: '改过默认值的设置', speedsPlayed: '各播放速度的时长', speedX: '{v}×',
    noneChanged: '没有人改过设置。',

    dailyFallbacks: '退回原播放器的页面', dailyFallbacksCap: '每天；不含用户主动切换',
    tipFallbacks: '次退回原播放器',
    pageCode: 'Echo360 页面代码版本', pageCodeCap: 'Echo360 脚本文件的名称。出现新名称说明 Echo360 改了播放器。',
    firstSeen: '首次出现于{when}', pageViews: '{v} 次观看', pageFallbacks_other: '{n} 次退回',
    reasons: '退回原播放器的原因', bootPaths: '脚本如何启动',
    boot_intercept: '在页面播放器启动前接管', boot_takeover: '接管已在运行的播放器',
    boot_fallback: '把页面留给原播放器', bootMedian: '中位数 {v} 显示播放器',
    chosen: '用户主动选择',
    r_startFailed: '播放器启动失败', r_noHls: '浏览器无法播放该视频流', r_noBootstrap: '页面没有按已知方式启动播放器',
    r_coreError: '播放中出现意外错误', r_playbackError: '视频因错误停止', r_auth: '登录已过期',
    r_user: '用户主动切换', r_extras: '打开了投票等仅原播放器有的部分', r_attachment: '打开了讨论附件',
    r_unsupported: '不支持的录像类型', r_libFailed: '视频库加载失败', r_noBootData: '页面上找不到启动数据',
    noFallbacks: '这段时间没有页面退回原播放器。',
    noFrontends: '这段时间没有看到 Echo360 页面代码。',

    footer: '只读。只显示汇总：没有用户 ID，也没有个人明细。筛选条件作用于页面上的所有数字。',
  },
};

// Feature and setting names from the telemetry Worker's lists (schema.js FEATURES, PREFS).
const FEATURE_NAMES = {
  en: {
    play: 'Play and pause', seek: 'Skip back and forward', seekbar: 'Seek bar', chapter: 'Chapters', volume: 'Volume', mute: 'Mute',
    fullscreen: 'Full screen', swap: 'Swap views', layout: 'Layout', speed: 'Speed', captions: 'Captions', transcript: 'Transcript',
    bookmark: 'Bookmarks', flag: 'Flags', tag: 'Tags', notes: 'Notes', discussion: 'Discussion', slides: 'Slides', copyFrame: 'Copy frame',
    copyCaptions: 'Copy captions', zoom: 'Zoom', loop: 'A-B loop', popout: 'Floating window', exportNotes: 'Export notes', help: 'Help',
    pdfAdd: 'Add a PDF', pdfTurn: 'Turn PDF pages', pdfFix: 'Correct PDF page', silenceSkip: 'Skip silence', quality: 'Quality',
    settings: 'Settings', original: 'Original player', diagnostics: 'Diagnostics', backup: 'Backup', theme: 'Theme', language: 'Language',
  },
  zh: {
    play: '播放和暂停', seek: '快退快进', seekbar: '进度条', chapter: '章节', volume: '音量', mute: '静音',
    fullscreen: '全屏', swap: '交换画面', layout: '布局', speed: '速度', captions: '字幕', transcript: '转录文本',
    bookmark: '书签', flag: '标记', tag: '标签', notes: '笔记', discussion: '讨论', slides: '幻灯片', copyFrame: '复制画面',
    copyCaptions: '复制字幕', zoom: '缩放', loop: 'A-B 循环', popout: '小窗', exportNotes: '导出笔记', help: '帮助',
    pdfAdd: '添加 PDF', pdfTurn: 'PDF 翻页', pdfFix: '纠正 PDF 页码', silenceSkip: '跳过静音', quality: '画质',
    settings: '设置', original: '原播放器', diagnostics: '诊断', backup: '备份', theme: '主题', language: '语言',
  },
};
const SETTING_NAMES = {
  en: {
    primary: 'Main view', layout: 'Layout', ratio: 'Split ratio', pipw: 'Picture-in-picture size', corner: 'Picture-in-picture corner',
    rate: 'Speed', volume: 'Volume', muted: 'Muted', captions: 'Captions', capSize: 'Caption size', capHidePaused: 'Hide captions when paused',
    panel: 'Side panel', tab: 'Side panel tab', panelw: 'Side panel width', 'audio.level': 'Level audio', 'audio.voice': 'Clearer voice',
    'audio.mono': 'Mono audio', 'silence.auto': 'Auto-skip silence', 'silence.min': 'Shortest silence', 'silence.sens': 'Silence sensitivity',
    copySpan: 'Copy span', pdfMain: 'PDF as main view', pdfFirst: 'PDF first', emptyCamera: 'Camera when screen is empty',
    'quality.screen': 'Screen quality', 'quality.camera': 'Camera quality', theme: 'Theme', lang: 'Language',
  },
  zh: {
    primary: '主画面', layout: '布局', ratio: '分屏比例', pipw: '画中画大小', corner: '画中画位置',
    rate: '速度', volume: '音量', muted: '静音', captions: '字幕', capSize: '字幕大小', capHidePaused: '暂停时隐藏字幕',
    panel: '侧栏', tab: '侧栏标签页', panelw: '侧栏宽度', 'audio.level': '音量均衡', 'audio.voice': '人声增强',
    'audio.mono': '单声道', 'silence.auto': '自动跳过静音', 'silence.min': '最短静音', 'silence.sens': '静音灵敏度',
    copySpan: '复制范围', pdfMain: 'PDF 作主画面', pdfFirst: 'PDF 优先', emptyCamera: '屏幕空白时显示摄像头',
    'quality.screen': '屏幕画质', 'quality.camera': '摄像头画质', theme: '主题', lang: '语言',
  },
};
const ALL_FEATURES = Object.keys(FEATURE_NAMES.en);

let LANG = 'en';

function t(key, vars) {
  const table = STRINGS[LANG];
  let s;
  if (vars && typeof vars.n === 'number') {
    s = table[key + (vars.n === 1 && table[key + '_one'] ? '_one' : '_other')];
  }
  if (s === undefined) s = table[key];
  if (s === undefined) s = STRINGS.en[key + (vars && vars.n === 1 ? '_one' : '_other')] ?? STRINGS.en[key] ?? key;
  // {n} is formatted as a number in the page's language.
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : k === 'n' && typeof vars[k] === 'number' ? fmtInt(vars[k]) : String(vars[k]))) : s;
}
function featureName(id) { return FEATURE_NAMES[LANG][id] || id; }
function settingName(id) { return SETTING_NAMES[LANG][id] || id; }
