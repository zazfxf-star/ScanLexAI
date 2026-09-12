import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  FileArchive,
  FileImage,
  Files,
  Globe2,
  Image as ImageIcon,
  Languages,
  LoaderCircle,
  LockKeyhole,
  Menu,
  MessageSquareText,
  RefreshCw,
  RotateCcw,
  ScanLine,
  Settings2,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useGetAppConfig,
  useTranslateChapters,
  useTranslateImage,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

const queryClient = new QueryClient();

type Mode = 'image' | 'chapter' | 'multi';

type Language = {
  code: string;
  label: string;
  nativeLabel: string;
  direction: 'ltr' | 'rtl';
};

type Region = {
  text: string;
  translatedText: string;
  x: number;
  y: number;
  width: number;
  height: number;
  orientation: string;
  regionType: string;
  confidence: number;
  fontSize: number;
  align: 'left' | 'center' | 'right';
};

type ImageResult = {
  id: string;
  originalImage: string;
  translatedImage: string;
  width: number;
  height: number;
  regions: Region[];
  targetLanguage: string;
  model: string;
};

type ChapterPage = {
  pageNumber: number;
  originalImage: string;
  translatedImage: string;
  width: number;
  height: number;
  regions: Region[];
};

type ChapterResult = {
  id: string;
  name: string;
  pageCount: number;
  pages: ChapterPage[];
  targetLanguage: string;
  model: string;
};

type MultiResult = {
  id: string;
  chapterCount: number;
  chapters: ChapterResult[];
  targetLanguage: string;
};

type Result = ImageResult | ChapterResult | MultiResult;

type AppShellContextValue = {
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
};

const AppShellContext = createContext<AppShellContextValue | null>(null);

function useAppShell() {
  const context = useContext(AppShellContext);
  if (!context) throw new Error('useAppShell must be used inside AppShell');
  return context;
}

const fallbackLanguages: Language[] = [
  { code: 'ar', label: 'Arabic', nativeLabel: 'العربية', direction: 'rtl' },
  { code: 'en', label: 'English', nativeLabel: 'English', direction: 'ltr' },
  { code: 'es', label: 'Spanish', nativeLabel: 'Español', direction: 'ltr' },
  { code: 'fr', label: 'French', nativeLabel: 'Français', direction: 'ltr' },
  { code: 'de', label: 'German', nativeLabel: 'Deutsch', direction: 'ltr' },
  { code: 'pt', label: 'Portuguese', nativeLabel: 'Português', direction: 'ltr' },
  { code: 'ko', label: 'Korean', nativeLabel: '한국어', direction: 'ltr' },
  { code: 'ja', label: 'Japanese', nativeLabel: '日本語', direction: 'ltr' },
];

const modeMeta: Record<Mode, { title: string; detail: string; icon: typeof ImageIcon }> = {
  image: { title: 'Translate image', detail: 'One page, one clear result', icon: FileImage },
  chapter: { title: 'Translate chapter', detail: 'A full chapter in order', icon: BookOpen },
  multi: { title: 'Translate 3 chapters', detail: 'Queue up to three chapters', icon: Files },
};

function unwrapResponse(data: any): any {
  if (!data) return data;
  if (typeof data === 'object' && 'data' in data && data.data) {
    return unwrapResponse(data.data);
  }
  if (typeof data === 'object' && 'result' in data && data.result) {
    return unwrapResponse(data.result);
  }
  return data;
}

function friendlyError(cause: unknown, fallback: string): string {
  const error = cause as {
    message?: unknown;
    data?: { error?: unknown; message?: unknown; detail?: unknown } | null;
    status?: number;
  } | null;
  const serverMessage =
    typeof error?.data?.error === 'string'
      ? error.data.error
      : typeof error?.data?.message === 'string'
        ? error.data.message
        : typeof error?.data?.detail === 'string'
          ? error.data.detail
          : undefined;
  const rawMessage = serverMessage ?? (typeof error?.message === 'string' ? error.message : '');

  if (error?.status === 429 || /429|rate limit|quota/i.test(rawMessage)) {
    return 'The translation service is temporarily busy. Please wait a moment and try again.';
  }
  if (error?.status === 503 || /503|unavailable|service unavailable/i.test(rawMessage)) {
    return 'The translation service is temporarily unavailable. Please try again shortly.';
  }
  if (/نوع الملف غير مدعوم|unsupported file/i.test(rawMessage)) {
    return 'This file type is not supported. Upload a JPG, PNG, WEBP, ZIP, or CBZ file.';
  }
  if (/لم يتم اختيار ملف فصل|choose a chapter/i.test(rawMessage)) {
    return 'Choose a chapter archive or page images before starting the translation.';
  }
  if (/HTTP \d+[^:]*:\s*/i.test(rawMessage)) {
    return rawMessage.replace(/^HTTP \d+[^:]*:\s*/i, '').trim() || fallback;
  }
  return rawMessage.trim() || fallback;
}

function requireImageResult(value: unknown): ImageResult {
  const result = unwrapResponse(value);
  if (!result || typeof result !== 'object' || typeof result.translatedImage !== 'string') {
    throw new Error('The translation finished without returning a translated image.');
  }
  return result as ImageResult;
}

function requireChapterResult(value: unknown): ChapterResult | MultiResult {
  const result = unwrapResponse(value);
  const hasPages = result && typeof result === 'object' && Array.isArray(result.pages) && result.pages.length > 0;
  const hasChapters =
    result &&
    typeof result === 'object' &&
    Array.isArray(result.chapters) &&
    result.chapters.length > 0 &&
    result.chapters.every((chapter: unknown) => {
      return Boolean(
        chapter &&
          typeof chapter === 'object' &&
          Array.isArray((chapter as { pages?: unknown }).pages) &&
          (chapter as { pages: unknown[] }).pages.length > 0,
      );
    });
  if (!hasPages && !hasChapters) {
    throw new Error('The translation finished without returning any translated pages.');
  }
  return result as ChapterResult | MultiResult;
}

type ChapterProgress = {
  current: number;
  total: number;
};

type ChapterJobStatus = {
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  name: string;
  targetLanguage: string;
  totalPages: number | null;
  completedPages: number;
  succeededPages: number[];
  failedPages: number[];
  complete: boolean;
  resultId: string | null;
  result: ChapterResult | null;
  error: string | null;
};

const chapterJobStorageKey = 'scanlex:chapter-job';

async function startChapterJob(
  files: File[],
  targetLanguage: string,
): Promise<{ jobId: string; targetLanguage: string }> {
  const formData = new FormData();
  if (files.length === 1 && /\.(zip|cbz)$/i.test(files[0].name)) {
    formData.append('file', files[0]);
  } else {
    files.forEach((file) => formData.append('images', file));
  }
  formData.append('targetLanguage', targetLanguage);

  const response = await fetch('/backend/translate/chapter', {
    method: 'POST',
    body: formData,
  });
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }
    const error = new Error(
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : typeof body === 'string'
          ? body
          : `HTTP ${response.status} ${response.statusText}`,
    ) as Error & { status?: number; data?: unknown };
    error.status = response.status;
    error.data = body;
    throw error;
  }

  const payload = await response.json() as { jobId?: string; targetLanguage?: string };
  if (!payload.jobId) {
    throw new Error('The chapter job could not be started.');
  }
  return {
    jobId: payload.jobId,
    targetLanguage: payload.targetLanguage || targetLanguage,
  };
}

async function fetchChapterJobStatus(jobId: string): Promise<ChapterJobStatus> {
  const response = await fetch(`/backend/translate/chapter/${jobId}/status`);
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${response.status} ${response.statusText}`,
    ) as Error & { status?: number; data?: unknown };
    error.status = response.status;
    error.data = payload;
    throw error;
  }
  return payload as ChapterJobStatus;
}

async function pollChapterJob(
  jobId: string,
  onProgress: (progress: ChapterProgress) => void,
  isActive: () => boolean = () => true,
): Promise<ChapterJobStatus> {
  let lastStatus: ChapterJobStatus | null = null;
  while (isActive()) {
    const status = await fetchChapterJobStatus(jobId);
    lastStatus = status;
    onProgress({
      current: status.completedPages,
      total: status.totalPages ?? Math.max(status.completedPages, 1),
    });

    if (status.complete) return status;
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
  }
  return lastStatus as ChapterJobStatus;
}

function LogoMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex items-center gap-2.5 ${compact ? '' : 'min-w-max'}`}>
      <div className="relative flex h-9 w-9 items-center justify-center rounded-[13px] rounded-br-[5px] bg-primary shadow-[0_8px_22px_hsl(187_94%_54%/0.16)]">
        <span className="font-sans text-[22px] font-extrabold leading-none tracking-[-0.12em] text-primary-foreground">S</span>
        <span className="absolute -bottom-1.5 right-0 h-2.5 w-2.5 rotate-45 rounded-[2px] bg-primary" />
      </div>
      {!compact && (
        <div>
          <div className="text-[15px] font-extrabold tracking-[-0.04em] text-foreground">ScanLex</div>
          <div className="font-mono text-[8px] uppercase tracking-[0.22em] text-muted-foreground">translation studio</div>
        </div>
      )}
    </div>
  );
}

function AppShell({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const shellContext = {
    settingsOpen,
    openSettings: () => {
      setSettingsOpen(true);
      setNavOpen(false);
    },
    closeSettings: () => setSettingsOpen(false),
  };

  return (
    <AppShellContext.Provider value={shellContext}>
      <div className="min-h-[100dvh] bg-transparent text-foreground">
      <header className="sticky top-0 z-30 flex h-[68px] items-center justify-between border-b border-border/80 bg-[#11171b] px-5 md:hidden">
        <LogoMark />
        <button
          type="button"
          className="focus-ring rounded-lg p-2 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          onClick={() => setNavOpen((value) => !value)}
          aria-label="Open navigation"
          data-testid="button-open-navigation"
        >
          {navOpen ? <X size={19} /> : <Menu size={19} />}
        </button>
      </header>

      {navOpen && (
        <div
          className="fixed inset-0 top-[68px] z-10 bg-[#0d1317] md:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`isolate fixed inset-x-0 top-[68px] z-20 border-b border-border bg-[#11171b] px-5 py-4 shadow-[0_18px_40px_rgba(0,0,0,0.35)] transition-transform md:inset-y-0 md:left-0 md:top-0 md:block md:w-[238px] md:translate-x-0 md:border-b-0 md:border-r md:px-4 md:py-5 ${
          navOpen ? 'translate-y-0' : '-translate-y-[130%] md:translate-y-0'
        }`}
      >
        <div className="hidden px-2 md:block"><LogoMark /></div>

        <nav className="mt-2 space-y-1 md:mt-10" aria-label="Primary navigation">
          <div className="mb-3 px-2 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Workspace</div>

          <button
            type="button"
            className="focus-ring flex w-full items-center gap-3 rounded-xl bg-[#17383f] px-3 py-2.5 text-left text-sm font-semibold text-primary"
            onClick={() => setNavOpen(false)}
            data-testid="button-nav-workspace"
          >
            <ScanLine size={17} />
            Translation workspace
          </button>

          <button
            type="button"
            className="focus-ring flex w-full items-center gap-3 rounded-xl bg-[#11171b] px-3 py-2.5 text-left text-sm text-muted-foreground transition hover:bg-[#1b292e] hover:text-foreground"
            onClick={() => setNavOpen(false)}
            data-testid="button-nav-guide"
          >
            <CircleHelp size={17} />
            Quick guide
          </button>

          <div className="my-5 border-t border-border/70" />
          <div className="mb-3 px-2 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Preferences</div>

          <button
            type="button"
            className="focus-ring flex w-full items-center gap-3 rounded-xl bg-[#11171b] px-3 py-2.5 text-left text-sm text-muted-foreground transition hover:bg-[#1b292e] hover:text-foreground"
            onClick={shellContext.openSettings}
            data-testid="button-nav-settings"
          >
            <Settings2 size={17} />
            Settings
          </button>
        </nav>

        <div className="absolute bottom-5 left-4 right-4 hidden rounded-2xl border border-border bg-card p-3.5 md:block">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <LockKeyhole size={14} className="text-primary" />
            Private by default
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            Your pages are processed for this translation only.
          </p>
        </div>
      </aside>

        <main className="md:pl-[238px]">{children}</main>
      </div>
    </AppShellContext.Provider>
  );
}

function StatusPill({ configured, model }: { configured: boolean; model: string }) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-[10px] text-muted-foreground" data-testid="status-service">
      <span className={`h-1.5 w-1.5 rounded-full ${configured ? 'bg-primary shadow-[0_0_0_3px_hsl(187_94%_54%/0.13)]' : 'bg-destructive'}`} />
      <span>{configured ? 'Ready' : 'Needs setup'}</span>
      {configured && (
        <span className="hidden border-l border-border pl-2 font-mono text-[9px] text-muted-foreground sm:inline">
          {model || 'ScanLex engine'}
        </span>
      )}
    </div>
  );
}

function ModePicker({ mode, setMode, disabled }: { mode: Mode; setMode: (mode: Mode) => void; disabled: boolean }) {
  return (
    <div className="grid gap-2.5 sm:grid-cols-3" data-testid="group-translation-modes">
      {(Object.keys(modeMeta) as Mode[]).map((key) => {
        const meta = modeMeta[key];
        const Icon = meta.icon;
        const active = mode === key;

        return (
          <button
            type="button"
            key={key}
            disabled={disabled}
            onClick={() => setMode(key)}
            className={`focus-ring group relative flex min-h-[76px] items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition duration-200 ${
              active
                ? 'border-primary/70 bg-primary/10 text-foreground shadow-[inset_0_0_0_1px_hsl(187_94%_54%/0.12)]'
                : 'border-border bg-card hover:border-muted-foreground/40 hover:bg-secondary'
            }`}
            data-testid={`button-mode-${key}`}
          >
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${active ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground group-hover:text-foreground'}`}>
              <Icon size={17} strokeWidth={1.8} />
            </span>

            <span className="min-w-0">
              <span className="block text-[12px] font-bold">{meta.title}</span>
              <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{meta.detail}</span>
            </span>

            {active && <Check className="absolute right-3 top-3 text-primary" size={14} />}
          </button>
        );
      })}
    </div>
  );
}

function LanguageSelect({
  languages,
  language,
  setLanguage,
  disabled,
}: {
  languages: Language[];
  language: string;
  setLanguage: (value: string) => void;
  disabled: boolean;
}) {
  const selected = languages.find((item) => item.code === language);

  return (
    <label className="relative block">
      <span className="mb-2 block font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">Translate into</span>
      <Globe2 className="pointer-events-none absolute bottom-3.5 left-3.5 text-primary" size={16} />

      <select
        value={language}
        onChange={(event) => setLanguage(event.target.value)}
        disabled={disabled}
        className="focus-ring h-12 w-full appearance-none rounded-xl border border-border bg-secondary pl-10 pr-9 text-sm font-semibold text-foreground outline-none transition hover:border-muted-foreground/50"
        data-testid="select-target-language"
      >
        {languages.map((item) => (
          <option value={item.code} key={item.code}>
            {item.label} · {item.nativeLabel}
          </option>
        ))}
      </select>

      <ChevronDown className="pointer-events-none absolute bottom-3.5 right-3.5 text-muted-foreground" size={16} />

      <span className="mt-1.5 block text-[10px] text-muted-foreground">
        {selected?.direction === 'rtl'
          ? 'Right-to-left typesetting will be preserved.'
          : 'Text placement and reading order will be preserved.'}
      </span>
    </label>
  );
}

function SettingsPanel({
  languages,
  language,
  setLanguage,
  disabled,
  onClose,
}: {
  languages: Language[];
  language: string;
  setLanguage: (value: string) => void;
  disabled: boolean;
  onClose: () => void;
}) {
  const selected = languages.find((item) => item.code === language) ?? languages[0];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[#080d10]/90 p-4 pt-[84px] sm:items-center sm:pt-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="w-full max-w-[480px] overflow-hidden rounded-2xl border border-border bg-[#11171b] shadow-[0_26px_80px_rgba(0,0,0,0.55)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        data-testid="panel-settings"
      >
        <div className="flex items-start justify-between border-b border-border bg-[#11171b] px-5 py-4">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">Preferences</p>
            <h2 id="settings-title" className="mt-1 text-lg font-extrabold tracking-[-0.03em]">Settings</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring rounded-lg bg-[#1b292e] p-2 text-muted-foreground transition hover:text-foreground"
            aria-label="Close settings"
            data-testid="button-close-settings"
          >
            <X size={17} />
          </button>
        </div>

        <div className="space-y-5 bg-[#11171b] p-5">
          <div>
            <h3 className="text-sm font-bold">Translation target language</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Choose any language supported by the translation service. This selection is used for new translations.
            </p>
          </div>

          <label className="block">
            <span className="mb-2 block font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
              Target language
            </span>
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              disabled={disabled || !languages.length}
              className="focus-ring w-full appearance-none rounded-xl border border-border bg-[#1b292e] px-3.5 py-3 text-sm font-semibold text-foreground outline-none disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="select-settings-language"
            >
              {languages.map((item) => (
                <option key={item.code} value={item.code} className="bg-[#11171b] text-foreground">
                  {item.label} · {item.nativeLabel}
                </option>
              ))}
            </select>
          </label>

          <div className="rounded-xl border border-primary/25 bg-[#163139] px-3.5 py-3">
            <div className="flex items-center gap-2 text-xs font-bold text-primary">
              <Languages size={15} />
              {selected ? `${selected.label} · ${selected.nativeLabel}` : 'Choose a language'}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              The main translation form is synchronized with this setting.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="focus-ring flex h-11 w-full items-center justify-center rounded-xl bg-primary px-4 text-sm font-extrabold text-primary-foreground transition hover:brightness-110"
            data-testid="button-done-settings"
          >
            Done
          </button>
        </div>
      </section>
    </div>
  );
}

function UploadArea({
  mode,
  files,
  setFiles,
  disabled,
  maxImageBytes,
  maxChapterBytes,
}: {
  mode: Mode;
  files: File[];
  setFiles: (files: File[]) => void;
  disabled: boolean;
  maxImageBytes?: number;
  maxChapterBytes?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const multi = mode !== 'image';
  const accepts = mode === 'image' ? 'image/*' : 'image/*,.zip,.cbz,.pdf';
  const maxSize = mode === 'image' ? maxImageBytes : maxChapterBytes;

  const maxLabel = maxSize
    ? `${Math.round(maxSize / (1024 * 1024))} MB max`
    : mode === 'image'
      ? 'Image files'
      : 'ZIP, CBZ, PDF or image files';

  const onFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const selected = Array.from(incoming);
    setFiles(multi ? selected.slice(0, 3) : selected.slice(0, 1));
  };

  return (
    <div>
      <span className="mb-2 block font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
        {multi ? 'Chapter files' : 'Source file'}
      </span>

      <input
        ref={inputRef}
        className="hidden"
        type="file"
        accept={accepts}
        multiple={multi}
        onChange={(event) => onFiles(event.target.files)}
        data-testid="input-source-files"
      />

      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className={`focus-ring group relative w-full rounded-2xl border border-dashed px-4 py-5 text-left transition ${
          files.length
            ? 'border-primary/60 bg-primary/5'
            : 'border-border bg-card hover:border-primary/60 hover:bg-primary/5'
        }`}
        data-testid="button-upload-files"
      >
        <div className="flex items-center gap-3">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${files.length ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground group-hover:text-primary'}`}>
            {files.length ? <Check size={18} /> : <Upload size={18} />}
          </span>

          <span className="min-w-0">
            <span className="block truncate text-sm font-bold">
              {files.length
                ? `${files.length} file${files.length > 1 ? 's' : ''} selected`
                : 'Choose files to translate'}
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {files.length ? files.map((file) => file.name).join(', ') : `${maxLabel} · Drop files here or browse`}
            </span>
          </span>

          {!files.length && <ArrowRight className="ml-auto shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary" size={17} />}
        </div>
      </button>

      {files.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {files.map((file, index) => (
            <div
              className="flex items-center gap-2 rounded-lg bg-secondary/70 px-2.5 py-2 text-[11px]"
              key={`${file.name}-${index}`}
              data-testid={`file-selected-${index}`}
            >
              {file.type.startsWith('image/') ? (
                <ImageIcon size={13} className="text-primary" />
              ) : (
                <FileArchive size={13} className="text-primary" />
              )}

              <span className="min-w-0 flex-1 truncate text-muted-foreground">{file.name}</span>
              <span className="font-mono text-[9px] text-muted-foreground">{(file.size / 1024 / 1024).toFixed(1)} MB</span>

              <button
                type="button"
                className="focus-ring rounded p-1 text-muted-foreground hover:text-foreground"
                onClick={() => setFiles(files.filter((_, itemIndex) => itemIndex !== index))}
                aria-label={`Remove ${file.name}`}
                data-testid={`button-remove-file-${index}`}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProgressPanel({ mode, chapterProgress }: { mode: Mode; chapterProgress: ChapterProgress | null }) {
  const steps = mode === 'image'
    ? ['Reading page', 'Finding dialogue', 'Rebuilding lettering']
    : ['Opening pages', 'Translating dialogue', 'Rebuilding lettering'];
  const hasChapterProgress = mode !== 'image' && chapterProgress !== null;
  const progressPercent = hasChapterProgress && chapterProgress.total > 0
    ? Math.min(100, Math.round((chapterProgress.current / chapterProgress.total) * 100))
    : 0;

  return (
    <div className="animate-rise rounded-2xl border border-primary/30 bg-primary/5 p-5" data-testid="status-translation-progress">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-bold">
            <LoaderCircle className="animate-spin text-primary" size={16} />
            {hasChapterProgress
              ? `Translating page ${chapterProgress.current} of ${chapterProgress.total}`
              : `Translating your ${mode === 'image' ? 'page' : 'chapter'}`}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">The lettering is being rebuilt directly on the artwork.</p>
        </div>
        <span className="font-mono text-[10px] text-primary">IN PROGRESS</span>
      </div>

      <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-primary/10">
        <div
          className={`h-full rounded-full bg-primary ${hasChapterProgress ? 'transition-[width] duration-300' : 'progress-pulse w-1/3'}`}
          style={hasChapterProgress ? { width: `${Math.max(4, progressPercent)}%` } : undefined}
        />
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {steps.map((step, index) => (
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground" key={step}>
            <span className={`flex h-4 w-4 items-center justify-center rounded-full ${index === 0 ? 'bg-primary text-primary-foreground' : 'border border-border'}`}>
              {index === 0 ? <Check size={10} /> : index + 1}
            </span>
            {step}
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-destructive/35 bg-destructive/10 p-4" role="alert" data-testid="status-translation-error">
      <AlertCircle className="mt-0.5 shrink-0 text-destructive" size={18} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">That translation did not finish</p>
        <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{message}</p>
      </div>

      <button
        type="button"
        onClick={onRetry}
        className="focus-ring flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-destructive hover:bg-destructive/10"
        data-testid="button-retry-translation"
      >
        <RefreshCw size={13} />
        Retry
      </button>
    </div>
  );
}

function ImageCompare({ result }: { result: ImageResult }) {
  const [view, setView] = useState<'translated' | 'original'>('translated');
  const [zoom, setZoom] = useState(1);
  const regions = Array.isArray(result?.regions) ? result.regions : [];

  if (!result) return null;

  return (
    <section className="animate-rise animate-rise-delay-1 mt-8" data-testid="section-translation-result">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.18em] text-primary">
            <Sparkles size={12} />
            Result ready
          </div>
          <h2 className="mt-1 text-xl font-extrabold tracking-[-0.04em]">Your page, understood.</h2>
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
          <button
            type="button"
            onClick={() => setView('translated')}
            className={`focus-ring rounded-md px-2.5 py-1.5 text-[10px] font-bold ${view === 'translated' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            data-testid="button-view-translated"
          >
            Translated
          </button>

          <button
            type="button"
            onClick={() => setView('original')}
            className={`focus-ring rounded-md px-2.5 py-1.5 text-[10px] font-bold ${view === 'original' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            data-testid="button-view-original"
          >
            Original
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-[#151c20] shadow-[0_22px_60px_hsl(210_40%_4%/0.34)]">
        <div className="soft-grid flex min-h-[320px] items-center justify-center overflow-auto p-4 sm:min-h-[440px] sm:p-8">
          <img
            src={view === 'translated' ? result.translatedImage : result.originalImage}
            alt={view === 'translated' ? 'Translated comic page' : 'Original comic page'}
            className="max-h-[680px] max-w-full rounded-sm object-contain transition-transform duration-300"
            style={{ transform: `scale(${zoom})` }}
            data-testid={`img-${view}-result`}
          />
        </div>

        <div className="flex items-center justify-between border-t border-border/80 bg-card px-3 py-2.5">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <MessageSquareText size={13} className="text-primary" />
            {regions.length} text regions found
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setZoom((value) => Math.max(0.7, value - 0.1))}
              className="focus-ring rounded px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
              data-testid="button-zoom-out"
            >
              −
            </button>

            <span className="w-9 text-center font-mono text-[9px] text-muted-foreground">{Math.round(zoom * 100)}%</span>

            <button
              type="button"
              onClick={() => setZoom((value) => Math.min(1.6, value + 0.1))}
              className="focus-ring rounded px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
              data-testid="button-zoom-in"
            >
              +
            </button>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>Model: <span className="font-mono text-foreground">{result.model || 'N/A'}</span></span>
        <span className="font-mono">{result.width ?? 0} × {result.height ?? 0}px</span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <a
          href={result.translatedImage}
          download="scanlex-translated-page.png"
          className="focus-ring inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground transition hover:brightness-110"
          data-testid="link-download-image"
        >
          Download translated page <ArrowRight size={14} />
        </a>
      </div>

      {regions.length > 0 && <RegionList regions={regions} />}
    </section>
  );
}

function RegionList({ regions }: { regions: Region[] }) {
  const [showRegions, setShowRegions] = useState(false);

  return (
    <div className="mt-5 overflow-hidden rounded-2xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setShowRegions((value) => !value)}
        className="focus-ring flex w-full items-center justify-between px-4 py-3 text-left"
        data-testid="button-toggle-text-regions"
      >
        <span className="flex items-center gap-2 text-xs font-bold">
          <Languages size={14} className="text-primary" />
          Text regions
          <span className="rounded-full bg-secondary px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">{regions.length}</span>
        </span>
        <ChevronDown size={15} className={`text-muted-foreground transition ${showRegions ? 'rotate-180' : ''}`} />
      </button>

      {showRegions && (
        <div className="border-t border-border px-4 pb-3">
          {regions.map((region, index) => (
            <div
              className="grid grid-cols-[1fr_auto_1fr] items-start gap-2 border-b border-border/60 py-3 last:border-0"
              key={`${region.x}-${index}`}
              data-testid={`region-${index}`}
            >
              <p className="text-[11px] leading-relaxed text-muted-foreground">{region.text}</p>
              <ArrowRight size={13} className="mt-0.5 text-primary" />
              <p className="text-[11px] font-medium leading-relaxed text-foreground">{region.translatedText}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChapterResultView({ result, isMulti }: { result: ChapterResult | MultiResult; isMulti: boolean }) {
  const [chapterIndex, setChapterIndex] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);

  if (!result) return null;

  const chapters = isMulti
    ? (result as MultiResult)?.chapters ?? []
    : [result as ChapterResult];

  const chapter = chapters[chapterIndex] ?? chapters[0];
  const pages = chapter?.pages ?? [];
  const page = pages[pageIndex] ?? pages[0];

  if (!chapter || !pages.length || !page) {
    return (
      <div className="mt-8 rounded-2xl border border-destructive/30 bg-destructive/10 p-6 text-center text-sm font-semibold text-foreground">
        No pages available in this translation result. Please check the uploaded file and try again.
      </div>
    );
  }

  const pageCount = chapter.pageCount || pages.length;

  return (
    <section className="animate-rise animate-rise-delay-1 mt-8" data-testid="section-chapter-result">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.18em] text-primary">
            <Sparkles size={12} />
            {isMulti ? `${chapters.length} chapters ready` : 'Chapter ready'}
          </div>
          <h2 className="mt-1 text-xl font-extrabold tracking-[-0.04em]">{chapter.name || 'Translated chapter'}</h2>
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[10px] text-muted-foreground">
          <BookOpen size={13} className="text-primary" />
          {pageCount} pages
        </div>
      </div>

      {isMulti && (
        <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
          {chapters.map((item, index) => (
            <button
              type="button"
              key={`${item.id ?? index}-${index}`}
              onClick={() => {
                setChapterIndex(index);
                setPageIndex(0);
              }}
              className={`focus-ring shrink-0 rounded-lg border px-3 py-2 text-left text-[10px] font-bold ${
                index === chapterIndex
                  ? 'border-primary/60 bg-primary/10 text-primary'
                  : 'border-border bg-card text-muted-foreground'
              }`}
              data-testid={`button-result-chapter-${index}`}
            >
              Chapter {index + 1}
              <span className="ml-2 font-mono font-normal">{item.pageCount ?? item.pages?.length ?? 0}p</span>
            </button>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-border bg-[#151c20] shadow-[0_22px_60px_hsl(210_40%_4%/0.34)]">
        <div className="soft-grid flex min-h-[320px] items-center justify-center p-4 sm:min-h-[440px] sm:p-8">
          <img
            src={page.translatedImage}
            alt={`Translated page ${page.pageNumber ?? pageIndex + 1}`}
            className="max-h-[680px] max-w-full rounded-sm object-contain"
            data-testid={`img-chapter-page-${page.pageNumber ?? pageIndex + 1}`}
          />
        </div>

        <div className="flex items-center justify-between border-t border-border/80 bg-card px-3 py-2.5">
          <button
            type="button"
            disabled={pageIndex === 0}
            onClick={() => setPageIndex((value) => value - 1)}
            className="focus-ring flex items-center gap-1 rounded-lg px-2 py-1.5 text-[10px] font-bold text-muted-foreground disabled:opacity-30 hover:bg-secondary hover:text-foreground"
            data-testid="button-previous-page"
          >
            <ChevronLeft size={14} />
            Previous
          </button>

          <span className="font-mono text-[10px] text-foreground">
            PAGE {String(page.pageNumber ?? pageIndex + 1).padStart(2, '0')}
            <span className="text-muted-foreground"> / {String(pageCount).padStart(2, '0')}</span>
          </span>

          <button
            type="button"
            disabled={pageIndex >= pages.length - 1}
            onClick={() => setPageIndex((value) => value + 1)}
            className="focus-ring flex items-center gap-1 rounded-lg px-2 py-1.5 text-[10px] font-bold text-muted-foreground disabled:opacity-30 hover:bg-secondary hover:text-foreground"
            data-testid="button-next-page"
          >
            Next
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{Array.isArray(page.regions) ? page.regions.length : 0} text regions on this page</span>
        <span className="font-mono">{page.width ?? 0} × {page.height ?? 0}px</span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <a
          href={`/backend/files/${chapter.id}/chapter.cbz`}
          download={`${chapter.name || 'scanlex-chapter'}.cbz`}
          className="focus-ring inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground transition hover:brightness-110"
          data-testid="link-download-chapter"
        >
          Download translated chapter <ArrowRight size={14} />
        </a>
      </div>

      {Array.isArray(page.regions) && page.regions.length > 0 && <RegionList regions={page.regions} />}
    </section>
  );
}

function Workspace() {
  const { settingsOpen, closeSettings } = useAppShell();
  const configQuery = useGetAppConfig({ query: { queryKey: ['/api/config'] } });
  const translateImage = useTranslateImage();
  const translateChapters = useTranslateChapters();

  const [mode, setMode] = useState<Mode>('image');
  const [language, setLanguage] = useState('ar');
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [lastFiles, setLastFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const [chapterProgress, setChapterProgress] = useState<ChapterProgress | null>(null);
  const [chapterStreamPending, setChapterStreamPending] = useState(false);
  const chapterPollRef = useRef<string | null>(null);

  const languages = configQuery.data?.supportedLanguages?.length
    ? configQuery.data.supportedLanguages
    : fallbackLanguages;

  const isPending =
    translateImage.isPending ||
    translateChapters.isPending ||
    chapterStreamPending;

  const selectedLanguage = useMemo(
    () => languages.find((item) => item.code === language) ?? languages[0] ?? fallbackLanguages[0],
    [language, languages],
  );

  const trackChapterJob = (jobId: string, targetLanguage: string) => {
    chapterPollRef.current = jobId;
    setMode('chapter');
    setLanguage(targetLanguage);
    setChapterStreamPending(true);

    return pollChapterJob(jobId, setChapterProgress, () => chapterPollRef.current === jobId)
      .then((status) => {
        if (chapterPollRef.current !== jobId) return;
        if (status.status !== 'completed' || !status.result) {
          throw new Error(status.error || 'The chapter job did not complete successfully.');
        }
        setResult(status.result);
        setError('');
      })
      .catch((cause) => {
        if (chapterPollRef.current !== jobId) return;
        setError(friendlyError(cause, 'The chapter could not be completed.'));
        window.localStorage.removeItem(chapterJobStorageKey);
      })
      .finally(() => {
        if (chapterPollRef.current === jobId) {
          setChapterStreamPending(false);
        }
      });
  };

  useEffect(() => {
    const savedJob = window.localStorage.getItem(chapterJobStorageKey);
    if (!savedJob) return;

    try {
      const parsed = JSON.parse(savedJob) as {
        jobId?: string;
        targetLanguage?: string;
      };
      if (parsed.jobId && parsed.targetLanguage) {
        setChapterProgress({ current: 0, total: 0 });
        trackChapterJob(parsed.jobId, parsed.targetLanguage);
      }
    } catch {
      window.localStorage.removeItem(chapterJobStorageKey);
    }

    return () => {
      chapterPollRef.current = null;
    };
  }, []);

  const submit = () => {
    if (!files.length || isPending) return;

    setError('');
    setResult(null);
    setLastFiles(files);
    setChapterProgress(mode === 'chapter' ? { current: 0, total: 0 } : null);

    if (mode === 'image') {
      translateImage.mutate(
        { data: { file: files[0], targetLanguage: language } },
        {
          onSuccess: (value) => {
            try {
              setResult(requireImageResult(value));
            } catch (cause) {
              setError(friendlyError(cause, 'The image could not be translated.'));
            }
          },
          onError: (cause) => setError(friendlyError(cause, 'The image could not be translated.')),
        },
      );
    } else if (mode === 'chapter') {
      setChapterStreamPending(true);
      void startChapterJob(files, language)
        .then(({ jobId, targetLanguage }) => {
          window.localStorage.setItem(
            chapterJobStorageKey,
            JSON.stringify({
              jobId,
              targetLanguage,
              name: files[0]?.name || 'chapter',
            }),
          );
          return trackChapterJob(jobId, targetLanguage);
        })
        .catch((cause) => {
          setError(friendlyError(cause, 'The chapter could not be translated.'));
          setChapterStreamPending(false);
        });
    } else {
      translateChapters.mutate(
        { data: { files, targetLanguage: language } },
        {
          onSuccess: (value) => {
            try {
              setResult(requireChapterResult(value));
            } catch (cause) {
              setError(friendlyError(cause, 'The chapters could not be translated.'));
            }
          },
          onError: (cause) => setError(friendlyError(cause, 'The chapters could not be translated.')),
        },
      );
    }
  };

  const retry = () => {
    setFiles(lastFiles);
    setError('');
    window.setTimeout(submit, 0);
  };

  const reset = () => {
    setFiles([]);
    setLastFiles([]);
    setResult(null);
    setError('');
    setChapterProgress(null);
    setChapterStreamPending(false);
    chapterPollRef.current = null;
    window.localStorage.removeItem(chapterJobStorageKey);
  };

  const modeChange = (nextMode: Mode) => {
    setMode(nextMode);
    setFiles([]);
    setResult(null);
    setError('');
    setChapterProgress(null);
  };

  return (
    <>
      <div className="mx-auto max-w-[1180px] px-5 pb-16 pt-7 sm:px-8 md:px-10 md:pt-10">
      <div className="animate-rise flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            Studio / new translation
          </div>

          <h1 className="max-w-[560px] text-[clamp(1.85rem,4vw,3.15rem)] font-extrabold leading-[1.03] tracking-[-0.065em]">
            From scan to story.
          </h1>

          <p className="mt-3 max-w-[540px] text-sm leading-relaxed text-muted-foreground sm:text-[15px]">
            A calm, readable translation layered back onto the page you actually want to read.
          </p>
        </div>

        <div className="hidden pt-1 sm:block">
          <StatusPill
            configured={configQuery.data?.serviceConfigured ?? true}
            model={configQuery.data?.model ?? 'ScanLex engine'}
          />
        </div>
      </div>

      <div className="mt-7 grid gap-8 lg:grid-cols-[minmax(0,470px)_minmax(0,1fr)] lg:gap-14">
        <section className="animate-rise animate-rise-delay-1">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-bold">Start a translation</h2>
            <span className="font-mono text-[9px] text-muted-foreground">01 / 02</span>
          </div>

          <ModePicker mode={mode} setMode={modeChange} disabled={isPending} />

          <div className="mt-6 space-y-5 rounded-2xl border border-border bg-card/70 p-4 sm:p-5">
            <LanguageSelect
              languages={languages}
              language={language}
              setLanguage={setLanguage}
              disabled={isPending}
            />

            <UploadArea
              mode={mode}
              files={files}
              setFiles={setFiles}
              disabled={isPending}
              maxImageBytes={configQuery.data?.maxImageBytes}
              maxChapterBytes={configQuery.data?.maxChapterBytes}
            />

            <button
              type="button"
              disabled={
                !files.length ||
                isPending ||
                (!configQuery.data?.serviceConfigured && configQuery.isFetched)
              }
              onClick={submit}
              className="focus-ring flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-extrabold text-primary-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
              data-testid="button-translate-now"
            >
              {isPending ? (
                <>
                  <LoaderCircle className="animate-spin" size={17} />
                  Building your result
                </>
              ) : (
                <>
                  Translate {files.length > 1 ? `${files.length} chapters` : 'now'}
                  <ArrowRight size={17} />
                </>
              )}
            </button>

            <div className="flex items-center justify-center gap-1.5 text-[10px] text-muted-foreground">
              <LockKeyhole size={12} className="text-primary" />
              Files are used only for this translation
            </div>
          </div>

          <div className="mt-5 flex items-start gap-3 rounded-xl border border-border/70 bg-secondary/40 p-3.5">
            <Sparkles size={16} className="mt-0.5 shrink-0 text-primary" />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              <span className="font-semibold text-foreground">Best results with clean scans.</span>{' '}
              ScanLex preserves panels, reading order, and the original mood of the lettering.
            </p>
          </div>

          {configQuery.isError && (
            <div
              className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-[11px] text-muted-foreground"
              data-testid="status-config-error"
            >
              <span className="flex items-center gap-2">
                <AlertCircle size={14} className="text-destructive" />
                Could not load service settings.
              </span>

              <button
                type="button"
                onClick={() => configQuery.refetch()}
                className="font-bold text-destructive"
                data-testid="button-retry-config"
              >
                Retry
              </button>
            </div>
          )}
        </section>

        <section className="min-w-0">
          {isPending && <ProgressPanel mode={mode} chapterProgress={chapterProgress} />}
          {!isPending && error && <ErrorPanel message={error} onRetry={retry} />}

          {!isPending && !error && result === null && (
            <div
              className="animate-rise animate-rise-delay-2 soft-grid flex min-h-[390px] flex-col items-center justify-center rounded-2xl border border-border bg-card/35 px-6 text-center sm:min-h-[480px]"
              data-testid="empty-translation-result"
            >
              <div className="relative mb-5 flex h-16 w-16 items-center justify-center rounded-[21px] border border-primary/25 bg-primary/10 text-primary">
                <ScanLine size={28} strokeWidth={1.5} />
                <span className="absolute -right-2 -top-2 h-3 w-3 rounded-full border-2 border-background bg-primary" />
              </div>

              <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
                Your canvas is clear
              </p>

              <h2 className="mt-2 text-xl font-extrabold tracking-[-0.04em]">
                The translated page will land here.
              </h2>

              <p className="mt-2 max-w-[300px] text-xs leading-relaxed text-muted-foreground">
                Choose a source above, then we’ll return the artwork with its dialogue translated in place.
              </p>

              <div className="mt-6 flex flex-wrap justify-center gap-2 text-[10px] text-muted-foreground">
                <span className="rounded-full border border-border bg-card px-2.5 py-1.5">Preserved layout</span>
                <span className="rounded-full border border-border bg-card px-2.5 py-1.5">Readable text</span>
                <span className="rounded-full border border-border bg-card px-2.5 py-1.5">Side-by-side view</span>
              </div>
            </div>
          )}

          {!isPending && !error && result && (() => {
            const activeResult = unwrapResponse(result);

            if (activeResult && typeof activeResult === 'object' && 'translatedImage' in activeResult) {
              return <ImageCompare result={activeResult as ImageResult} />;
            }

            if (activeResult && typeof activeResult === 'object' && Array.isArray(activeResult.pages) && activeResult.pages.length > 0) {
              if (mode === 'image') {
                const firstPage = activeResult.pages[0];
                const imgResult: ImageResult = {
                  id: activeResult.id || '1',
                  originalImage: firstPage.originalImage,
                  translatedImage: firstPage.translatedImage,
                  width: firstPage.width,
                  height: firstPage.height,
                  regions: firstPage.regions || [],
                  targetLanguage: activeResult.targetLanguage || language,
                  model: activeResult.model || 'ScanLex engine',
                };
                return <ImageCompare result={imgResult} />;
              }
              return <ChapterResultView result={activeResult as ChapterResult} isMulti={false} />;
            }

            if (activeResult && typeof activeResult === 'object' && Array.isArray(activeResult.chapters) && activeResult.chapters.length > 0) {
              return <ChapterResultView result={activeResult as MultiResult} isMulti={true} />;
            }

            return (
              <div className="mt-8 rounded-2xl border border-destructive/30 bg-destructive/10 p-6 text-center text-sm font-semibold text-foreground">
                No pages available in this translation result. Please check the uploaded file and try again.
              </div>
            );
          })()}

          {result && !isPending && (
            <button
              type="button"
              onClick={reset}
              className="focus-ring mx-auto mt-6 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              data-testid="button-new-translation"
            >
              <RotateCcw size={14} />
              Start another translation
            </button>
          )}
        </section>
      </div>

      <footer className="mt-16 flex flex-col gap-2 border-t border-border/70 pt-5 text-[10px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span>ScanLex AI · made for the pages worth understanding.</span>
        <span className="font-mono">
          MODEL STATUS <span className="text-primary">●</span> {selectedLanguage?.label ?? 'Arabic'} ready
        </span>
      </footer>
      </div>
      {settingsOpen && (
        <SettingsPanel
          languages={languages}
          language={language}
          setLanguage={setLanguage}
          disabled={isPending}
          onClose={closeSettings}
        />
      )}
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ErrorBoundary>
          <AppShell>
            <Workspace />
          </AppShell>
        </ErrorBoundary>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
