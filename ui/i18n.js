/*
 * Mechano DM interface language (English / Arabic).
 *
 * The pages are written in English. When the language is Arabic this file:
 *   - switches the page to right-to-left,
 *   - translates every piece of text it knows (whole strings, plus a few patterns for
 *     text with numbers in it), including text added later (a MutationObserver),
 *   - leaves file names, links, paths and logs alone (see SKIP).
 * The language comes from Settings (config.language: auto / en / ar); "auto" follows Windows.
 */
(function () {
  'use strict';
  const root = document.documentElement;
  let lang = root.dataset.lang || 'auto';
  if (lang !== 'ar' && lang !== 'en') lang = /^ar\b/i.test(navigator.language || '') ? 'ar' : 'en';
  root.dataset.lang = lang;

  const AR = {
    // ---- shared / dialog
    'Download File Info': 'معلومات ملف التحميل',
    'URL': 'الرابط', 'Category': 'الفئة', 'Quality': 'الجودة', 'Save As': 'حفظ باسم', 'Description': 'الوصف',
    'Connections': 'الاتصالات', 'parts downloaded at the same time': 'أجزاء بتتحمّل في نفس الوقت',
    'Optional note for this download': 'ملاحظة اختيارية للتحميل ده',
    "Don't ask again": 'متسألنيش تاني', 'Cancel': 'إلغاء', 'Download Later': 'حمّل بعدين', 'Start Download': 'ابدأ التحميل',
    'Copy link': 'نسخ الرابط', 'Choose folder': 'اختيار فولدر', 'Link copied.': 'تم نسخ الرابط.',
    'File': 'ملف', 'Stream': 'بث', 'Video site': 'موقع فيديو', 'Playlist': 'قائمة تشغيل', 'Torrent': 'تورنت', 'FILE': 'ملف',
    'Length': 'المدة', 'Resume: Yes': 'استكمال: متاح', 'Resume: No': 'استكمال: غير متاح', 'Size unknown': 'الحجم غير معروف',
    'General': 'عام', 'Video': 'فيديو', 'Music': 'صوتيات', 'Compressed': 'مضغوطة', 'Documents': 'مستندات', 'Programs': 'برامج', 'Images': 'صور',
    'Best': 'أفضل جودة', 'Best quality': 'أفضل جودة', 'Best available': 'أفضل جودة متاحة', 'Audio only (MP3)': 'صوت فقط (MP3)', 'Audio only': 'صوت فقط',
    'This download was already handled.': 'التحميل ده اتعامل معاه خلاص.',
    'Playlist videos are saved in a folder here': 'فيديوهات القائمة بتتحفظ في فولدر هنا',
    'Playlist: every video is downloaded one after another. You can skip or re-order them in the main window.':
      'قائمة تشغيل: الفيديوهات بتتحمّل واحد ورا التاني. تقدر تتخطى أو ترتّب أي فيديو من النافذة الرئيسية.',
    'Save As needs a full path, like D:\\Downloads\\file.zip': 'حفظ باسم محتاج مسار كامل، زي D:\\Downloads\\file.zip',
    'Choose a full folder path, like D:\\Videos': 'اختار مسار فولدر كامل، زي D:\\Videos',
    'This link is a web page; the video on it will be downloaded with yt-dlp.': 'الرابط ده صفحة ويب؛ الفيديو اللي فيها هيتحمّل بـ yt-dlp.',

    // ---- main window: header + popups
    'Mechano Download Manager': 'Mechano لإدارة التحميلات', 'Download Manager': 'لإدارة التحميلات',
    'Update yt-dlp now (YouTube / Facebook fixes)': 'حدّث yt-dlp دلوقتي (إصلاحات يوتيوب / فيسبوك)', 'Update yt-dlp now': 'حدّث yt-dlp دلوقتي',
    'Scheduler': 'الجدولة', 'Settings': 'الإعدادات', 'Theme: Auto (follows Windows)': 'المظهر: تلقائي (زي ويندوز)', 'Theme: Auto': 'المظهر: تلقائي',
    'New download': 'تحميل جديد', 'Save to': 'حفظ في', 'Browse…': 'استعراض…', '⏰ Later': '⏰ بعدين', 'Start download': 'ابدأ التحميل',
    'Working out the folder…': 'بنحدّد الفولدر…', 'Getting details…': 'بنجيب التفاصيل…',
    // scheduler
    'Add links with': 'ضيف الروابط بزرار', 'Later': 'بعدين', 'instead of Download. They wait here and start at the time you choose.': 'بدل تحميل. هتستنى هنا وتبدأ في الوقت اللي تختاره.',
    'Files in queue': 'الملفات في الطابور', 'Schedule': 'المواعيد', 'Download': 'تحميل', 'files at the same time': 'ملفات في نفس الوقت',
    'File name': 'اسم الملف', 'Size': 'الحجم', 'Status': 'الحالة', 'Time left': 'الوقت المتبقي',
    'Move down': 'لتحت', 'Move up': 'لفوق', 'Remove from the queue (does not delete anything)': 'شيله من الطابور (مش هيمسح حاجة)', 'Remove from queue': 'شيله من الطابور',
    'Click a file, then ↑ ↓ — or drag it. Files download in this order.': 'دوس على ملف وبعدين ↑ ↓ — أو اسحبه. الملفات بتتحمّل بالترتيب ده.',
    'Turn on the scheduler': 'شغّل الجدولة', 'Start downloading at': 'ابدأ التحميل الساعة', 'Stop at (optional)': 'وقّف الساعة (اختياري)',
    'Do nothing': 'متعملش حاجة', 'Sleep': 'سكون', 'Hibernate': 'إسبات', 'Restart the computer': 'أعد تشغيل الكمبيوتر', 'Shut down the computer': 'اقفل الكمبيوتر',
    'When the scheduled downloads finish': 'لما التحميلات المجدولة تخلص', 'Days (none ticked = every day)': 'الأيام (من غير علامة = كل يوم)',
    'Sat': 'سبت', 'Sun': 'أحد', 'Mon': 'اتنين', 'Tue': 'تلات', 'Wed': 'أربع', 'Thu': 'خميس', 'Fri': 'جمعة',
    'Save schedule': 'احفظ المواعيد', '▶ Start now': '▶ ابدأ دلوقتي', '■ Stop': '■ وقّف', 'Close scheduler': 'اقفل الجدولة', 'Close settings': 'اقفل الإعدادات',
    'The queue is empty. Paste a link and press ⏰ Later to add it here.': 'الطابور فاضي. الصق رابط ودوس ⏰ بعدين عشان يتضاف هنا.',
    'Downloading scheduled items:': 'تحميل العناصر المجدولة:', 'off': 'مقفول', 'on': 'شغال',
    // settings
    'Link type': 'نوع الرابط', 'Auto works for almost every link. Change it only if a link fails.': 'التلقائي بيشتغل مع أغلب الروابط. غيّره بس لو رابط فشل.',
    'Auto (recommended)': 'تلقائي (مُستحسن)', 'Media site: YouTube, Facebook… (yt-dlp)': 'موقع ميديا: يوتيوب، فيسبوك… (yt-dlp)',
    'Direct file, multi-connection': 'ملف مباشر، اتصالات متعددة', 'HLS stream (.m3u8)': 'بث HLS (.m3u8)',
    'Download folder': 'فولدر التحميل', 'Simultaneous downloads': 'تحميلات في نفس الوقت', 'Connections per file': 'اتصالات لكل ملف',
    'Parallel HLS segments': 'أجزاء HLS متوازية', 'Speed limit, KB/s (0 = unlimited)': 'حد السرعة KB/ث (0 = مفتوح)',
    'yt-dlp path (blank = auto)': 'مسار yt-dlp (فاضي = تلقائي)', 'ffmpeg path (blank = auto)': 'مسار ffmpeg (فاضي = تلقائي)',
    'Auto-update yt-dlp every … days (0 = off)': 'تحديث yt-dlp تلقائي كل … يوم (0 = مقفول)',
    'Stable (recommended)': 'مستقر (مُستحسن)', 'Nightly (newest YouTube fixes first)': 'ليلي (أحدث إصلاحات يوتيوب الأول)',
    'Sort into category folders (Video, Music, Compressed...)': 'رتّب في فولدرات حسب الفئة (فيديو، صوتيات، مضغوطة...)',
    'Ask before every download (shows where it will be saved)': 'اسألني قبل كل تحميل (ويوريني هيتحفظ فين)',
    'Show a "Download complete" window with Open / Show in folder': 'اظهر نافذة "اكتمل التحميل" فيها فتح / عرض في الفولدر',
    'Save settings': 'احفظ الإعدادات', 'Browser extension token (only needed if automatic pairing fails):': 'رمز إضافة المتصفح (محتاجه بس لو الربط التلقائي فشل):',
    'Language': 'اللغة', 'Auto (Windows)': 'تلقائي (حسب ويندوز)', 'English': 'English', 'العربية': 'العربية',
    'Watch the clipboard for download links': 'راقب الحافظة (النسخ) لروابط التحميل',
    'Fast video downloads (multi-connection for YouTube and others)': 'تحميل فيديو سريع (اتصالات متعددة ليوتيوب وغيره)',
    'App updates': 'تحديثات البرنامج', 'Tell me (recommended)': 'بلّغني (مُستحسن)', 'Install automatically': 'ثبّت تلقائي', 'Off': 'مقفول',
    'Check for app update': 'دوّر على تحديث للبرنامج', 'Install update': 'ثبّت التحديث', 'Later ': 'بعدين ',
    // link bar
    'YouTube / Facebook / Instagram / TikTok': 'يوتيوب / فيسبوك / إنستجرام / تيك توك',
    'See the qualities, size or playlist videos before downloading': 'شوف الجودات والحجم أو فيديوهات القائمة قبل التحميل',
    'Inspect': 'فحص', 'Add to the scheduler: downloads at the scheduled time': 'ضيفه للجدولة: هيتحمّل في الميعاد',
    'Whole playlist': 'القائمة كلها', 'Download every video of a YouTube playlist into its own folder': 'حمّل كل فيديوهات قائمة يوتيوب في فولدر لوحدها',
    'Start at': 'ابدأ الساعة', 'Show tool status (yt-dlp, ffmpeg)': 'حالة الأدوات (yt-dlp، ffmpeg)', 'Show less': 'عرض أقل',
    'Pause all': 'إيقاف الكل', 'Resume all': 'استكمال الكل', 'Clear finished': 'امسح المنتهي', 'Show fewer downloads': 'عرض تحميلات أقل',
    'Show all downloads': 'عرض كل التحميلات', 'Show less ▴': 'عرض أقل ▴',
    'Inspecting…': 'بنفحص…', 'playlist': 'قائمة تشغيل', 'Press': 'دوس',
    'Click a row to pick an exact format (video-only rows are merged with the best audio automatically). Otherwise the best quality is chosen.':
      'دوس على صف عشان تختار صيغة بالظبط (صفوف الفيديو بس بتتدمج مع أفضل صوت تلقائي). غير كده هيختار أفضل جودة.',
    'ID': 'المعرّف', 'Ext': 'الامتداد', 'Codec': 'الترميز', 'Audio': 'الصوت', 'Note': 'ملاحظة',
    'resumable, multi-connection': 'يقبل الاستكمال، اتصالات متعددة', 'single connection, not resumable': 'اتصال واحد، مش بيقبل الاستكمال',
    // list
    'No downloads here yet.': 'مفيش تحميلات هنا لسه.', 'Pause': 'إيقاف', 'Resume': 'استكمال', 'Retry': 'إعادة المحاولة',
    'Start now': 'ابدأ دلوقتي', 'Download now instead of waiting': 'حمّل دلوقتي بدل ما تستنى', 'Move to the scheduler': 'انقله للجدولة',
    'Folder': 'الفولدر', 'Log': 'السجل', 'Play': 'تشغيل', 'Play what is downloaded so far': 'شغّل اللي اتحمّل لحد دلوقتي',
    'Show the videos of this playlist': 'اعرض فيديوهات القائمة دي', 'Done': 'خلص', 'Failed': 'فشل',
    'Download this video': 'حمّل الفيديو ده', 'Skip this video': 'تخطّى الفيديو ده', 'Try again': 'حاول تاني',
    'The video list appears as soon as the playlist has been read.': 'قائمة الفيديوهات هتظهر أول ما القائمة تتقري.',
    'downloading': 'بيتحمّل', 'starting': 'بيبدأ', 'queued': 'في الانتظار', 'paused': 'متوقف', 'done': 'خلص', 'error': 'خطأ',
    'merging': 'بيدمج', 'scheduled': 'مجدول', 'waiting for your OK': 'مستني موافقتك', 'confirm': 'مستني موافقتك',
    'direct': 'ملف', 'hls': 'بث', 'ytdlp': 'موقع فيديو', 'torrent': 'تورنت', 'grab': 'جرّاب',
    'found': 'موجود', 'not found': 'مش موجود', 'JS runtime for YouTube:': 'محرك JS ليوتيوب:',
    '(YouTube & social sites need it)': '(يوتيوب ومواقع السوشيال محتاجينه)', '(needed to merge HD video + audio)': '(محتاجه لدمج فيديو HD مع الصوت)',
    'Also delete the unfinished partial file?': 'أمسح كمان الملف الجزئي اللي مكملش؟',
    'Settings saved': 'تم حفظ الإعدادات', 'Added to the scheduler (⏰)': 'اتضاف للجدولة (⏰)',
    'Downloads now start without asking. Turn it back on in ⚙ Settings.': 'التحميلات هتبدأ من غير ما تسأل. ترجّعها من ⚙ الإعدادات.',
    'Stopped. Unfinished items wait for the next start.': 'اتوقف. اللي مخلصش هيستنى المرة الجاية.',
    'Cancelled. The computer stays on.': 'اتلغى. الكمبيوتر هيفضل شغال.',
    'Removed from the queue (kept in the list as paused)': 'اتشال من الطابور (موجود في القائمة كمتوقف)',
    'A YouTube/social download is running. yt-dlp will update as soon as it finishes.': 'فيه تحميل يوتيوب/سوشيال شغال. yt-dlp هيتحدّث أول ما يخلص.',
    'today': 'النهارده', 'yesterday': 'امبارح', 'soon': 'قريب', 'tomorrow': 'بكره',
    'All': 'الكل', 'Active': 'النشطة', 'Scheduled': 'المجدولة', 'Paused': 'المتوقفة', 'Error': 'الأخطاء',
    // tools: grabber / torrent
    'Site Grabber': 'جرّاب المواقع', 'Grab': 'اجمع', 'Torrent / magnet': 'تورنت / ماجنت',
    'New version available': 'فيه نسخة جديدة', 'Clipboard': 'الحافظة',
    'Releases page': 'صفحة الإصدارات', '▶ Play': '▶ تشغيل',
    'Lists the files linked from a web page (and its pages on the same site). Tick what you want and press Download selected.':
      'بيطلّع الملفات اللي ليها روابط في صفحة ويب (وصفحاتها على نفس الموقع). علّم على اللي عايزه ودوس حمّل المحدد.',
    'This page only': 'الصفحة دي بس', '+ pages it links to': '+ الصفحات اللي بتوصل لها', '2 levels deep': 'مستويين لجوه', 'How deep to look': 'هيدوّر لحد فين',
    'Find files': 'دوّر على الملفات', 'Download selected': 'حمّل المحدد', 'Looking for files…': 'بندوّر على الملفات…',
    'More extensions: .iso .dwg': 'امتدادات تانية: .iso .dwg', 'Close Site Grabber': 'اقفل جرّاب المواقع', 'Updating…': 'بيتحدّث…', 'Scheduler saved (off)': 'الجدولة اتحفظت (مقفولة)', 'Download method: Auto': 'طريقة التحميل: تلقائي',
    'Added to the scheduler. Open ⏰ to turn it on and pick a time.': 'اتضاف للجدولة. افتح ⏰ عشان تشغّلها وتختار ميعاد.',
  };

  // Text with numbers or names inside it.
  const tr = (s) => (AR[s] != null ? AR[s] : s);
  const PATTERNS = [
    [/^(\d+) of (\S+)$/, (m) => `${m[1]} من ${m[2]}`],
    [/^\+(\d+) more waiting$/, (m) => `+${m[1]} في الانتظار`],
    [/^Remember this path for "(.+)" category$/, (m) => `تذكّر المسار ده لفئة «${tr(m[1])}»`],
    [/^(All|Active|Scheduled|Paused|Done|Error|Confirm) \((\d+)\)$/, (m) => `${tr(m[1])} (${m[2]})`],
    [/^(\d+) active · (.+)\/s$/, (m) => `${m[1]} نشط · ${m[2]}/ث`],
    [/^Show (\d+) more ▾$/, (m) => `عرض ${m[1]} كمان ▾`],
    [/^Show only (\d+)$/, (m) => `عرض ${m[1]} بس`],
    [/^waiting for the scheduler(?: · starts (.+))?( \(scheduler is off\))?$/, (m) => `مستني الجدولة${m[1] ? ' · يبدأ ' + m[1] : ''}${m[2] ? ' (الجدولة مقفولة)' : ''}`],
    [/^(\w+) · video (\d+) of (\S+)$/, (m) => `${tr(m[1])} · فيديو ${m[2]} من ${m[3]}`],
    [/^done · (\d+) videos(?: \((\d+) skipped\))?( \(some failed\))?$/, (m) => `خلص · ${m[1]} فيديو${m[2] ? ` (${m[2]} اتخطى)` : ''}${m[3] ? ' (فيه اللي فشل)' : ''}`],
    [/^(.*)\/s · ETA (.*) · (\d+) conn$/, (m) => `${m[1]}/ث · فاضل ${m[2]} · ${m[3]} اتصال`],
    [/^scheduled (.+)$/, (m) => `مجدول ${m[1]}`],
    [/^Theme: (Auto|Light|Dark)(.*)$/, (m) => `المظهر: ${{ Auto: 'تلقائي', Light: 'فاتح', Dark: 'غامق' }[m[1]]}`],
    [/^Scheduler: (\d+) files? at the same time$/, (m) => `الجدولة: ${m[1]} ملف في نفس الوقت`],
    [/^Videos(?: \((\d+)\))? ([▴▾])$/, (m) => `الفيديوهات${m[1] ? ` (${m[1]})` : ''} ${m[2]}`],
    [/^(\d+) days ago$/, (m) => `من ${m[1]} يوم`],
    [/^in (\d+) days$/, (m) => `بعد ${m[1]} يوم`],
    [/^Length: (.+)$/, (m) => `المدة: ${m[1]}`],
    [/^Updated (today|yesterday|\d+ days ago)(?: · next (soon|tomorrow|in \d+ days))?$/, (m) => `اتحدّث ${t(m[1])}${m[2] ? ' · الجاي ' + t(m[2]) : ''}`],
    [/^Could not read the details \((.*)\)\. You can still start the download\.$/, (m) => `مقدرناش نقرا التفاصيل (${m[1]}). تقدر تبدأ التحميل برضه.`],
    [/^Scheduled downloads finished\. (.+) in (\d+) seconds…$/, (m) => `التحميلات المجدولة خلصت. ${m[1]} بعد ${m[2]} ثانية…`],
    [/^Scheduler on · next start (.+)$/, (m) => `الجدولة شغالة · البداية الجاية ${m[1]}`],
    [/^Added to the scheduler · starts (.+)$/, (m) => `اتضاف للجدولة · يبدأ ${m[1]}`],
    [/^Download method changed: (.+)$/, (m) => `طريقة التحميل اتغيرت: ${t(m[1])}`],
    [/^next start$/, () => 'البداية الجاية'],
    [/^\(stops at (.+)\)$/, (m) => `(يقف الساعة ${m[1]})`],
    [/^No files found on (\d+) page\(s\)\.$/, (m) => `ملقيناش ملفات في ${m[1]} صفحة.`],
    [/^(\d+) files on (\d+) page\(s\)$/, (m) => `${m[1]} ملف في ${m[2]} صفحة`],
    [/^Added (\d+) downloads$/, (m) => `اتضاف ${m[1]} تحميل`],
    [/^New version available: Mechano DM (\S+) \(you have (\S+)\)(?: · (.*))?$/, (m) => `فيه نسخة جديدة: Mechano DM ${m[1]} (عندك ${m[2]})${m[3] ? ' · ' + m[3] : ''}`],
    [/^Downloading Mechano DM (\S+)… (\d+)%$/, (m) => `بيتم تحميل Mechano DM ${m[1]}… ${m[2]}%`],
    [/^Installing Mechano DM (\S+)\. The app restarts by itself\.$/, (m) => `بيتم تثبيت Mechano DM ${m[1]}. البرنامج هيعيد تشغيل نفسه.`],
    [/^(.+) \((\d[\d.]* ?[KMGT]?B)\)$/, (m) => (AR[m[1]] ? `${AR[m[1]]} (${m[2]})` : null)],
  ];

  function t(s) {
    if (lang !== 'ar' || s == null) return s;
    const str = String(s);
    const key = str.trim();
    if (!key) return str;
    let out = AR[key];
    if (out == null) {
      for (const [re, fn] of PATTERNS) { const m = key.match(re); if (m) { out = fn(m); if (out != null) break; } }
    }
    if (out == null) return str;
    const lead = str.match(/^\s*/)[0], trail = str.match(/\s*$/)[0];
    return lead + out + trail;
  }

  window.MDM_I18N = { lang, t, AR };
  if (lang !== 'ar') return;

  root.lang = 'ar';
  root.dir = 'rtl';

  // Things that are names, links, paths or logs: never translated.
  const SKIP = 'script,style,code,textarea,[translate="no"],.name,.log,.err,.cf-name,.cf-url,td.t,#tok,#url,#saveAs,.facts [translate="no"]';
  const ATTRS = ['title', 'placeholder', 'aria-label'];

  function translateText(node) {
    const p = node.parentElement;
    if (!p || p.closest(SKIP)) return;
    const v = node.nodeValue;
    const n = t(v);
    if (n !== v) node.nodeValue = n;
  }
  function translateEl(el) {
    if (el.closest && el.closest(SKIP)) return;
    for (const a of ATTRS) {
      if (el.hasAttribute && el.hasAttribute(a)) {
        const v = el.getAttribute(a), n = t(v);
        if (n !== v) el.setAttribute(a, n);
      }
    }
  }
  function walk(rootNode) {
    if (rootNode.nodeType === 3) return translateText(rootNode);
    if (rootNode.nodeType !== 1) return;
    translateEl(rootNode);
    const w = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = w.nextNode())) n.nodeType === 3 ? translateText(n) : translateEl(n);
  }

  // Small layout fixes for right-to-left (the main page uses left/right in a few places).
  const css = document.createElement('style');
  css.textContent = `
    body { font-family: "Segoe UI Variable Text", "Segoe UI", Tahoma, system-ui, sans-serif; }
    header .stat { margin-left: 0; margin-right: auto; }
    .upd-info { text-align: left; margin-right: 0; margin-left: 4px; }
    .collapse-btn { right: auto; left: 10px; }
    .tools-btn { left: auto; right: 10px; }
    .pl-table th, .q-table th { text-align: right; }
    .pl-table td.mv { text-align: left; }
    input[type=url], #url, #saveAs, .cf-url, code, .name { direction: ltr; unicode-bidi: plaintext; }
  `;
  document.head.appendChild(css);

  const start = () => {
    walk(document.body);
    if (document.title) document.title = t(document.title);
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'characterData') translateText(m.target);
        else if (m.type === 'attributes') translateEl(m.target);
        else m.addedNodes.forEach(walk);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

  // Messages shown with alert()/confirm()
  const a = window.alert.bind(window), c = window.confirm.bind(window);
  window.alert = (m) => a(t(m));
  window.confirm = (m) => c(t(m));
})();
