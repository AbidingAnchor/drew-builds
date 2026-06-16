import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://uebwvjadirkzouvfjuyo.supabase.co'
const supabaseKey = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVlYnd2amFkaXJrem91dmZqdXlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNzE4MjEsImV4cCI6MjA5NTk0NzgyMX0.rU2CaFBo35X8YWNiC-4oLSTxcQ9aRHmx5fKRKZOaqoU

export const supabase = createClient(supabaseUrl, supabaseKey)
