// Ready-made SMTP settings for common providers. Picking one fills in the
// server details; staff then enter only the username, password and sender.

export interface MailProviderPreset {
  id: string;
  label: string;
  host: string;
  port: number;
  security: "tls" | "starttls" | "none";
  /** What the provider calls the username and password, shown as hints. */
  usernameHint: string;
  passwordHint: string;
}

export const MAIL_PROVIDERS: readonly MailProviderPreset[] = [
  { id: "hostinger", label: "Hostinger email", host: "smtp.hostinger.com", port: 465, security: "tls", usernameHint: "The full mailbox address", passwordHint: "The mailbox password" },
  { id: "google", label: "Google Workspace / Gmail", host: "smtp.gmail.com", port: 465, security: "tls", usernameHint: "The full Google address", passwordHint: "An app password (Google account > Security > App passwords)" },
  { id: "microsoft", label: "Microsoft 365 / Outlook", host: "smtp.office365.com", port: 587, security: "starttls", usernameHint: "The full mailbox address", passwordHint: "The mailbox password or an app password" },
  { id: "zoho", label: "Zoho Mail", host: "smtp.zoho.com", port: 465, security: "tls", usernameHint: "The full mailbox address", passwordHint: "An app-specific password" },
  { id: "ses", label: "Amazon SES", host: "email-smtp.eu-west-1.amazonaws.com", port: 587, security: "starttls", usernameHint: "SES SMTP username (not your AWS key)", passwordHint: "SES SMTP password" },
  { id: "brevo", label: "Brevo", host: "smtp-relay.brevo.com", port: 587, security: "starttls", usernameHint: "Your Brevo SMTP login", passwordHint: "Brevo SMTP key" },
  { id: "mailgun", label: "Mailgun", host: "smtp.mailgun.org", port: 587, security: "starttls", usernameHint: "SMTP login, e.g. postmaster@mg.yourdomain.com", passwordHint: "SMTP password" },
  { id: "sendgrid", label: "SendGrid", host: "smtp.sendgrid.net", port: 587, security: "starttls", usernameHint: "Always the word apikey", passwordHint: "Your SendGrid API key" },
  { id: "postmark", label: "Postmark", host: "smtp.postmarkapp.com", port: 587, security: "starttls", usernameHint: "Server API token", passwordHint: "Server API token" },
  { id: "custom", label: "Other SMTP server", host: "", port: 587, security: "starttls", usernameHint: "Usually the full email address", passwordHint: "Password or SMTP key" },
];
