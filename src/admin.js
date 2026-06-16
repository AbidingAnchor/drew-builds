import { supabase } from './supabaseClient.js'

const ADMIN_PASSWORD = 'DrewBuilds2026'
const SESSION_KEY = 'drew_builds_admin'

const loginGate = document.getElementById('loginGate')
const adminDashboard = document.getElementById('adminDashboard')
const loginForm = document.getElementById('loginForm')
const passwordInput = document.getElementById('passwordInput')
const loginError = document.getElementById('loginError')
const logoutBtn = document.getElementById('logoutBtn')
const submissionsBody = document.getElementById('submissionsBody')
const submissionsEmpty = document.getElementById('submissionsEmpty')
const submissionsLoading = document.getElementById('submissionsLoading')
const submissionsError = document.getElementById('submissionsError')
const tableScroll = document.getElementById('tableScroll')

const STATUS_OPTIONS = ['New', 'Contacted', 'In Progress', 'Closed']

function isLoggedIn() {
  return sessionStorage.getItem(SESSION_KEY) === 'true'
}

function showDashboard() {
  loginGate.hidden = true
  adminDashboard.hidden = false
  logoutBtn.hidden = false
  loadSubmissions()
}

function showLogin() {
  loginGate.hidden = false
  adminDashboard.hidden = true
  logoutBtn.hidden = true
  sessionStorage.removeItem(SESSION_KEY)
}

function formatDate(dateString) {
  if (!dateString) return '—'
  return new Date(dateString).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

function createStatusSelect(id, currentStatus) {
  const select = document.createElement('select')
  select.className = 'status-select'
  select.dataset.id = id

  STATUS_OPTIONS.forEach((status) => {
    const option = document.createElement('option')
    option.value = status
    option.textContent = status
    option.selected = status === currentStatus
    select.appendChild(option)
  })

  select.addEventListener('change', async () => {
    select.disabled = true
    const { error } = await supabase
      .from('drew_builds_contacts')
      .update({ status: select.value })
      .eq('id', id)

    select.disabled = false

    if (error) {
      alert('Failed to update status. Please try again.')
      loadSubmissions()
    }
  })

  return select
}

async function loadSubmissions() {
  submissionsLoading.hidden = false
  submissionsError.hidden = true
  submissionsEmpty.hidden = true
  tableScroll.hidden = true
  submissionsBody.innerHTML = ''

  const { data, error } = await supabase
    .from('drew_builds_contacts')
    .select('*')
    .order('created_at', { ascending: false })

  submissionsLoading.hidden = true

  if (error) {
    submissionsError.textContent = `Failed to load submissions: ${error.message}`
    submissionsError.hidden = false
    return
  }

  if (!data?.length) {
    submissionsEmpty.hidden = false
    return
  }

  tableScroll.hidden = false

  data.forEach((row) => {
    const tr = document.createElement('tr')

    tr.innerHTML = `
      <td>${escapeHtml(row.name)}</td>
      <td><a href="mailto:${escapeHtml(row.email)}">${escapeHtml(row.email)}</a></td>
      <td>${escapeHtml(row.phone || '—')}</td>
      <td class="message-cell">${escapeHtml(row.message)}</td>
      <td>${formatDate(row.created_at)}</td>
      <td class="status-cell"></td>
    `

    tr.querySelector('.status-cell').appendChild(
      createStatusSelect(row.id, row.status || 'New')
    )

    submissionsBody.appendChild(tr)
  })
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault()
  loginError.hidden = true

  if (passwordInput.value === ADMIN_PASSWORD) {
    sessionStorage.setItem(SESSION_KEY, 'true')
    passwordInput.value = ''
    showDashboard()
  } else {
    loginError.hidden = false
  }
})

logoutBtn.addEventListener('click', showLogin)

if (isLoggedIn()) {
  showDashboard()
}
