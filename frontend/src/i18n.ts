import { useAuth } from './store'

export type Lang = 'en' | 'hi'

const dict = {
  en: {
    // existing
    title: 'My Safety', myId: 'My Digital ID', score: 'Safety score', panic: 'PANIC',
    panicSent: 'Help request sent to the control room.', panicFail: 'No data connection. Send an SMS instead:',
    sendSms: 'Send SMS', share: 'Share live location with family', shareLink: 'Family link',
    language: 'Language', alerts: 'Recent alerts', noAlerts: 'No alerts.', tracking: 'Location tracking',
    on: 'On', off: 'Off', noGps: 'Location unavailable. Enable GPS permission.', noId: 'No digital ID yet. Visit an entry-point officer.',
    lastSent: 'Last sent', validTo: 'Valid until',
    // tabs
    tabHome: 'Home', tabMap: 'Map', tabSafety: 'Safety', tabId: 'ID', tabSettings: 'Settings',
    // home
    statusSafe: 'You are in a safe area', statusNear: 'Risk area nearby', statusInside: 'You are inside a risk area',
    statusNoGps: 'Waiting for your location', holdToSend: 'HOLD', holdHint: 'Press and hold for 1.5 seconds to send a help request. Let go early to cancel.',
    cantHold: "Can't hold? Send with confirmation", confirmTitle: 'Send help request?',
    confirmMsg: 'The control room and your emergency contacts will be alerted with your last location.', sendNow: 'Send now', cancel: 'Cancel',
    nextStop: 'Next planned stop', noTrip: 'No itinerary on file.',
    // panic states
    panicQueued: 'No connection. Your request is saved and will be sent the moment you are online.',
    panicAck: 'The control room has seen your request.', panicDispatched: 'Help is on the way.',
    panicResolved: 'Your request has been closed.', panicCancelled: 'Request cancelled.',
    mistake: 'It was a mistake: cancel', cancelTooLate: 'The control room already has your request. Please speak to them directly.',
    // offline
    offlineBanner: 'You are offline. Your location is saved and will be sent when you reconnect.', saved: 'saved to send',
    // map
    trail: 'Your trail', zoneInside: 'You are inside {zone}. Move away from this area.', zoneNear: '{zone} is {dist} away.',
    recenter: 'Centre on me',
    // safety
    scoreParts: 'What affects your score', partZone: 'Risk areas within 1 km', partNight: 'Night time (8 pm to 5 am)', partMove: 'Unusual movement in the last hour',
    tipsTitle: 'Safety tips', tip1: 'Keep your phone charged and share your plan with someone you trust.', tip2: 'Stay on marked trails and avoid unfamiliar areas after dark.',
    tip3: 'If you lose signal, stay where you are if safe: your last location is saved.', tip4: 'Keep your digital ID QR ready for check-posts.',
    // id
    idHelp: 'Show this QR at check-posts. It can be verified offline and contains no personal data.', verifyLink: 'Verify an ID', revokedBanner: 'This ID has been revoked',
    // settings
    shareHelp: 'Only people with this link can see your live location. Turn it off any time.', copyLink: 'Copy link', copied: 'Copied',
    contacts: 'Emergency contacts', noContacts: 'No contacts available.', installApp: 'Install app', installed: 'App installed',
    installHelp: 'Add this app to your home screen to open it faster and use it offline.', account: 'Account and password',
    trackingHelp: 'Needed for safety alerts. Your location is sent every 15 to 60 seconds.',
  },
  hi: {
    title: 'मेरी सुरक्षा', myId: 'मेरी डिजिटल आईडी', score: 'सुरक्षा स्कोर', panic: 'आपातकाल',
    panicSent: 'सहायता अनुरोध नियंत्रण कक्ष को भेज दिया गया।', panicFail: 'डेटा कनेक्शन नहीं है। इसके बजाय SMS भेजें:',
    sendSms: 'SMS भेजें', share: 'परिवार के साथ लाइव लोकेशन साझा करें', shareLink: 'परिवार लिंक',
    language: 'भाषा', alerts: 'हाल की चेतावनियाँ', noAlerts: 'कोई चेतावनी नहीं।', tracking: 'लोकेशन ट्रैकिंग',
    on: 'चालू', off: 'बंद', noGps: 'लोकेशन उपलब्ध नहीं। GPS अनुमति चालू करें।', noId: 'अभी कोई डिजिटल आईडी नहीं। प्रवेश-बिंदु अधिकारी से मिलें।',
    lastSent: 'अंतिम भेजा', validTo: 'मान्य तिथि',
    tabHome: 'होम', tabMap: 'नक्शा', tabSafety: 'सुरक्षा', tabId: 'आईडी', tabSettings: 'सेटिंग',
    statusSafe: 'आप सुरक्षित क्षेत्र में हैं', statusNear: 'पास में जोखिम क्षेत्र है', statusInside: 'आप जोखिम क्षेत्र के अंदर हैं',
    statusNoGps: 'आपकी लोकेशन की प्रतीक्षा है', holdToSend: 'दबाएँ', holdHint: 'सहायता अनुरोध भेजने के लिए 1.5 सेकंड तक दबाए रखें। जल्दी छोड़ने पर रद्द हो जाएगा।',
    cantHold: 'दबाए नहीं रख सकते? पुष्टि के साथ भेजें', confirmTitle: 'सहायता अनुरोध भेजें?',
    confirmMsg: 'नियंत्रण कक्ष और आपके आपातकालीन संपर्कों को आपकी अंतिम लोकेशन के साथ सूचित किया जाएगा।', sendNow: 'अभी भेजें', cancel: 'रद्द करें',
    nextStop: 'अगला नियोजित पड़ाव', noTrip: 'कोई यात्रा कार्यक्रम दर्ज नहीं है।',
    panicQueued: 'कनेक्शन नहीं है। आपका अनुरोध सहेज लिया गया है और ऑनलाइन होते ही भेज दिया जाएगा।',
    panicAck: 'नियंत्रण कक्ष ने आपका अनुरोध देख लिया है।', panicDispatched: 'सहायता रास्ते में है।',
    panicResolved: 'आपका अनुरोध बंद कर दिया गया है।', panicCancelled: 'अनुरोध रद्द किया गया।',
    mistake: 'गलती से दब गया: रद्द करें', cancelTooLate: 'नियंत्रण कक्ष के पास आपका अनुरोध पहले से है। कृपया उनसे सीधे बात करें।',
    offlineBanner: 'आप ऑफ़लाइन हैं। आपकी लोकेशन सहेजी जा रही है और कनेक्शन लौटने पर भेज दी जाएगी।', saved: 'भेजने के लिए सहेजे गए',
    trail: 'आपका मार्ग', zoneInside: 'आप {zone} के अंदर हैं। इस क्षेत्र से दूर जाएँ।', zoneNear: '{zone} {dist} दूर है।',
    recenter: 'मुझ पर केंद्रित करें',
    scoreParts: 'आपके स्कोर को क्या प्रभावित करता है', partZone: '1 किमी के भीतर जोखिम क्षेत्र', partNight: 'रात का समय (रात 8 से सुबह 5)', partMove: 'पिछले घंटे में असामान्य गतिविधि',
    tipsTitle: 'सुरक्षा सुझाव', tip1: 'फ़ोन चार्ज रखें और अपनी योजना किसी भरोसेमंद व्यक्ति को बताएँ।', tip2: 'चिह्नित रास्तों पर रहें और अँधेरे के बाद अनजान जगहों से बचें।',
    tip3: 'सिग्नल चले जाए तो सुरक्षित हो तो वहीं रुकें: आपकी अंतिम लोकेशन सहेजी जा चुकी है।', tip4: 'चेक-पोस्ट के लिए अपनी डिजिटल आईडी का QR तैयार रखें।',
    idHelp: 'चेक-पोस्ट पर यह QR दिखाएँ। इसे ऑफ़लाइन जाँचा जा सकता है और इसमें कोई निजी जानकारी नहीं है।', verifyLink: 'आईडी जाँचें', revokedBanner: 'यह आईडी रद्द कर दी गई है',
    shareHelp: 'केवल इस लिंक वाले लोग आपकी लाइव लोकेशन देख सकते हैं। कभी भी बंद करें।', copyLink: 'लिंक कॉपी करें', copied: 'कॉपी हो गया',
    contacts: 'आपातकालीन संपर्क', noContacts: 'कोई संपर्क उपलब्ध नहीं।', installApp: 'ऐप इंस्टॉल करें', installed: 'ऐप इंस्टॉल है',
    installHelp: 'इस ऐप को होम स्क्रीन पर जोड़ें ताकि यह तेज़ खुले और ऑफ़लाइन भी चले।', account: 'खाता और पासवर्ड',
    trackingHelp: 'सुरक्षा चेतावनियों के लिए आवश्यक। आपकी लोकेशन हर 15 से 60 सेकंड में भेजी जाती है।',
  },
} as const

export type Key = keyof (typeof dict)['en']

export function translate(lang: string, key: Key, vars?: Record<string, string | number>): string {
  let s: string = (dict[lang as Lang] ?? dict.en)[key] ?? dict.en[key]
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
  return s
}

export function useT() {
  const lang = useAuth((s) => s.user?.language ?? 'en')
  return (key: Key, vars?: Record<string, string | number>) => translate(lang, key, vars)
}

/** Every key must exist in every language (checked by a unit test). */
export const LANGUAGES = Object.keys(dict) as Lang[]
export const keysOf = (lang: Lang) => Object.keys(dict[lang]) as Key[]
