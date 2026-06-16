import { supabase } from './supabaseClient.js'

const FORMSPREE_URL = 'https://formspree.io/f/mzdoyenz'

export async function submitProjectForm(formData) {
  const data = Object.fromEntries(formData)

  let formspreeError = null
  let supabaseError = null

  try {
    const response = await fetch(FORMSPREE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    if (!response.ok) {
      formspreeError = new Error('Formspree submission failed')
    }
  } catch (error) {
    formspreeError = error
  }

  try {
    const { error } = await supabase.from('drew_builds_contacts').insert([
      {
        name: data.name,
        email: data.email,
        phone: data.phone || null,
        message: data.message,
        business: data.business || null,
        business_type: data.businessType || null,
        service_needed: data.serviceNeeded || null,
        referral: data.referral || null,
        status: 'New',
      },
    ])

    if (error) {
      supabaseError = new Error(error.message)
    }
  } catch (error) {
    supabaseError = error
  }

  if (formspreeError && supabaseError) {
    throw new Error('Unable to submit form. Please try again.')
  }

  if (formspreeError) {
    throw formspreeError
  }

  if (supabaseError) {
    throw supabaseError
  }

  return true
}
