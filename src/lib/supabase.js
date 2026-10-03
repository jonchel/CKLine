// Клиент Supabase: авторизация по логину (email) и паролю.
// Значения берутся из переменных окружения Vite (.env):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.warn("Supabase не настроен: заполните .env (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)");
}

export const supabase = createClient(url ?? "http://localhost", anonKey ?? "anon", {
  auth: { persistSession: true, autoRefreshToken: true },
});

export async function signIn(login, password) {
  const email = login.includes("@") ? login : `${login}@app.local`; // логин мастера -> email Supabase Auth
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function fetchProfile(userId) {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).single();
  if (error) throw error;
  return data;
}
