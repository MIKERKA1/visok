// Доступ к базе от имени бота (service_role). Ключи берутся из окружения Edge Function, в коде их нет.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import type { Role } from './logic.ts';

export const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;

// Схема не сгенерирована в типы, поэтому строки приходят как any; ошибка запроса превращается в исключение.
// deno-lint-ignore no-explicit-any
export async function must(q: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>): Promise<any> {
  const { data, error } = await q;
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data;
}

// Секреты из vault: заголовок от базы и secret_token вебхука. Читаются один раз на жизнь процесса.
let secrets: { bot_internal_secret: string; bot_webhook_secret: string } | null = null;
export async function getSecrets() {
  secrets ||= await must(db.rpc('bot_secrets'));
  return secrets!;
}

// Справочники меняются в админке сайта, поэтому держим их не дольше минуты.
interface Ref { services: Row[]; masters: Row[]; masterServices: Row[]; tz: string; settings: Row }
let ref: Ref | null = null;
let refAt = 0;
export async function getRef(): Promise<Ref> {
  if (ref && Date.now() - refAt < 60_000) return ref;
  const [services, masters, masterServices, settings] = await Promise.all([
    must(db.from('services').select('*').eq('is_active', true).order('sort_order')),
    must(db.from('masters').select('*').eq('is_active', true).order('sort_order')),
    must(db.from('master_services').select('*')),
    must(db.from('settings').select('*').single()),
  ]);
  ref = { services, masters, masterServices, tz: settings.timezone, settings };
  refAt = Date.now();
  return ref;
}

export async function getClient(tgId: number): Promise<Row | null> {
  return await must(db.from('clients').select('*').eq('telegram_id', tgId).maybeSingle());
}

export async function saveClient(tgId: number, patch: Row): Promise<Row> {
  return await must(db.from('clients')
    .upsert({ telegram_id: tgId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'telegram_id' })
    .select().single());
}

export interface Who { role: Role; masterId: string | null; masterName: string | null; isAdmin: boolean }
export async function whoIs(tgId: number): Promise<Who> {
  const [admin, master] = await Promise.all([
    must(db.from('bot_admins').select('telegram_id').eq('telegram_id', tgId).maybeSingle()),
    must(db.from('masters').select('id,name').eq('telegram_chat_id', tgId).maybeSingle()),
  ]);
  return {
    role: admin ? 'admin' : master ? 'master' : 'client',
    isAdmin: !!admin,
    masterId: master?.id ?? null,
    masterName: master?.name ?? null,
  };
}

export async function adminIds(): Promise<number[]> {
  return (await must(db.from('bot_admins').select('telegram_id'))).map((r: Row) => Number(r.telegram_id));
}
