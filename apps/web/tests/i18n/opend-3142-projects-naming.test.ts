/**
 * OPEND-3142 · 侧栏项目入口与项目列表页标题从「个人项目」统一改为「项目」，
 * 英文从 "Personal projects" 改为 "Projects"，19 语齐。
 *
 * 只改值，不改键：`entry.navDrafts`（入口的 aria-label 与 `/drafts` 页标题）和
 * `workspaceSwitcher.draftsTooltip`（入口可见文案）。每个 locale 的目标值就是该
 * locale 已有的 `entry.navProjects`（"Projects" 这个名词的既有译文），不重译。
 *
 * 反向对照钉住旧值：光断言新值，一个把词典塞回英文占位的回归也能过。
 */
import { describe, expect, it } from 'vitest';

import { LOCALES, type Dict, type Locale } from '../../src/i18n/types';

async function loadDict(locale: Locale): Promise<Dict> {
  const module = await import(`../../src/i18n/locales/${locale}.ts`);
  const dict = Object.values(module).find((value): value is Dict => {
    return Boolean(value) && typeof value === 'object';
  });
  if (!dict) throw new Error(`No dictionary export found for locale ${locale}`);
  return dict;
}

const RENAMED_KEYS = ['entry.navDrafts', 'workspaceSwitcher.draftsTooltip'] as const;

/** 改之前那一版「个人项目」。命中说明这个语言被漏掉了。 */
const OLD_PERSONAL_PROJECTS: Record<Locale, string> = {
  ar: 'المشاريع الشخصية',
  de: 'Persönliche Projekte',
  en: 'Personal projects',
  'es-ES': 'Proyectos personales',
  fa: 'پروژه‌های شخصی',
  fr: 'Projets personnels',
  hu: 'Személyes projektek',
  id: 'Proyek pribadi',
  it: 'Progetti personali',
  ja: '個人プロジェクト',
  ko: '개인 프로젝트',
  pl: 'Projekty osobiste',
  'pt-BR': 'Projetos pessoais',
  ru: 'Личные проекты',
  th: 'โปรเจกต์ส่วนตัว',
  tr: 'Kişisel projeler',
  uk: 'Особисті проєкти',
  'zh-CN': '个人项目',
  'zh-TW': '個人專案',
};

describe('OPEND-3142 · 「个人项目」→「项目」', () => {
  it('English reads "Projects" and Simplified Chinese reads 「项目」 — the two strings the ticket names', async () => {
    const en = await loadDict('en');
    const zh = await loadDict('zh-CN');
    for (const key of RENAMED_KEYS) {
      expect(en[key]).toBe('Projects');
      expect(zh[key]).toBe('项目');
    }
  }, 30_000);

  it.each(LOCALES)('%s: the entry and the page title use the locale\'s own "Projects" noun', async (locale) => {
    const dict = await loadDict(locale);
    for (const key of RENAMED_KEYS) {
      expect(dict[key], `${locale} ${key}`).toBe(dict['entry.navProjects']);
      expect(dict[key], `${locale} ${key} still says "Personal projects"`).not.toBe(
        OLD_PERSONAL_PROJECTS[locale],
      );
    }
  }, 30_000);
});
