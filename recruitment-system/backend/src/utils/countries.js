/**
 * ISO 3166-1 country list with default domain assignment.
 *
 * `domain_default` is one of:
 *   - 'middle_east' (Gulf + Levant + Arabian Peninsula)
 *   - 'europe'      (EU + UK + EFTA + Balkans)
 *   - null          (everywhere else — agent must choose explicitly)
 *
 * Used by:
 *   - POST /api/jobs and PUT /api/jobs/:id to suggest domain when only
 *     country is provided.
 *   - The AI ingestion OpenAI prompt to constrain the extracted domain.
 *   - The frontend country dropdown.
 */

const COUNTRIES = [
    { code: 'AF', name: 'Afghanistan', domain_default: null },
    { code: 'AL', name: 'Albania', domain_default: 'europe' },
    { code: 'DZ', name: 'Algeria', domain_default: null },
    { code: 'AD', name: 'Andorra', domain_default: 'europe' },
    { code: 'AO', name: 'Angola', domain_default: null },
    { code: 'AG', name: 'Antigua and Barbuda', domain_default: null },
    { code: 'AR', name: 'Argentina', domain_default: null },
    { code: 'AM', name: 'Armenia', domain_default: null },
    { code: 'AU', name: 'Australia', domain_default: null },
    { code: 'AT', name: 'Austria', domain_default: 'europe' },
    { code: 'AZ', name: 'Azerbaijan', domain_default: null },
    { code: 'BS', name: 'Bahamas', domain_default: null },
    { code: 'BH', name: 'Bahrain', domain_default: 'middle_east' },
    { code: 'BD', name: 'Bangladesh', domain_default: null },
    { code: 'BB', name: 'Barbados', domain_default: null },
    { code: 'BY', name: 'Belarus', domain_default: 'europe' },
    { code: 'BE', name: 'Belgium', domain_default: 'europe' },
    { code: 'BZ', name: 'Belize', domain_default: null },
    { code: 'BJ', name: 'Benin', domain_default: null },
    { code: 'BT', name: 'Bhutan', domain_default: null },
    { code: 'BO', name: 'Bolivia', domain_default: null },
    { code: 'BA', name: 'Bosnia and Herzegovina', domain_default: 'europe' },
    { code: 'BW', name: 'Botswana', domain_default: null },
    { code: 'BR', name: 'Brazil', domain_default: null },
    { code: 'BN', name: 'Brunei', domain_default: null },
    { code: 'BG', name: 'Bulgaria', domain_default: 'europe' },
    { code: 'BF', name: 'Burkina Faso', domain_default: null },
    { code: 'BI', name: 'Burundi', domain_default: null },
    { code: 'CV', name: 'Cabo Verde', domain_default: null },
    { code: 'KH', name: 'Cambodia', domain_default: null },
    { code: 'CM', name: 'Cameroon', domain_default: null },
    { code: 'CA', name: 'Canada', domain_default: null },
    { code: 'CF', name: 'Central African Republic', domain_default: null },
    { code: 'TD', name: 'Chad', domain_default: null },
    { code: 'CL', name: 'Chile', domain_default: null },
    { code: 'CN', name: 'China', domain_default: null },
    { code: 'CO', name: 'Colombia', domain_default: null },
    { code: 'KM', name: 'Comoros', domain_default: null },
    { code: 'CG', name: 'Congo', domain_default: null },
    { code: 'CD', name: 'Congo (Democratic Republic)', domain_default: null },
    { code: 'CR', name: 'Costa Rica', domain_default: null },
    { code: 'CI', name: "Côte d'Ivoire", domain_default: null },
    { code: 'HR', name: 'Croatia', domain_default: 'europe' },
    { code: 'CU', name: 'Cuba', domain_default: null },
    { code: 'CY', name: 'Cyprus', domain_default: 'europe' },
    { code: 'CZ', name: 'Czech Republic', domain_default: 'europe' },
    { code: 'DK', name: 'Denmark', domain_default: 'europe' },
    { code: 'DJ', name: 'Djibouti', domain_default: null },
    { code: 'DM', name: 'Dominica', domain_default: null },
    { code: 'DO', name: 'Dominican Republic', domain_default: null },
    { code: 'EC', name: 'Ecuador', domain_default: null },
    { code: 'EG', name: 'Egypt', domain_default: 'middle_east' },
    { code: 'SV', name: 'El Salvador', domain_default: null },
    { code: 'GQ', name: 'Equatorial Guinea', domain_default: null },
    { code: 'ER', name: 'Eritrea', domain_default: null },
    { code: 'EE', name: 'Estonia', domain_default: 'europe' },
    { code: 'SZ', name: 'Eswatini', domain_default: null },
    { code: 'ET', name: 'Ethiopia', domain_default: null },
    { code: 'FJ', name: 'Fiji', domain_default: null },
    { code: 'FI', name: 'Finland', domain_default: 'europe' },
    { code: 'FR', name: 'France', domain_default: 'europe' },
    { code: 'GA', name: 'Gabon', domain_default: null },
    { code: 'GM', name: 'Gambia', domain_default: null },
    { code: 'GE', name: 'Georgia', domain_default: null },
    { code: 'DE', name: 'Germany', domain_default: 'europe' },
    { code: 'GH', name: 'Ghana', domain_default: null },
    { code: 'GR', name: 'Greece', domain_default: 'europe' },
    { code: 'GD', name: 'Grenada', domain_default: null },
    { code: 'GT', name: 'Guatemala', domain_default: null },
    { code: 'GN', name: 'Guinea', domain_default: null },
    { code: 'GW', name: 'Guinea-Bissau', domain_default: null },
    { code: 'GY', name: 'Guyana', domain_default: null },
    { code: 'HT', name: 'Haiti', domain_default: null },
    { code: 'HN', name: 'Honduras', domain_default: null },
    { code: 'HU', name: 'Hungary', domain_default: 'europe' },
    { code: 'IS', name: 'Iceland', domain_default: 'europe' },
    { code: 'IN', name: 'India', domain_default: null },
    { code: 'ID', name: 'Indonesia', domain_default: null },
    { code: 'IR', name: 'Iran', domain_default: 'middle_east' },
    { code: 'IQ', name: 'Iraq', domain_default: 'middle_east' },
    { code: 'IE', name: 'Ireland', domain_default: 'europe' },
    { code: 'IL', name: 'Israel', domain_default: 'middle_east' },
    { code: 'IT', name: 'Italy', domain_default: 'europe' },
    { code: 'JM', name: 'Jamaica', domain_default: null },
    { code: 'JP', name: 'Japan', domain_default: null },
    { code: 'JO', name: 'Jordan', domain_default: 'middle_east' },
    { code: 'KZ', name: 'Kazakhstan', domain_default: null },
    { code: 'KE', name: 'Kenya', domain_default: null },
    { code: 'KI', name: 'Kiribati', domain_default: null },
    { code: 'KW', name: 'Kuwait', domain_default: 'middle_east' },
    { code: 'KG', name: 'Kyrgyzstan', domain_default: null },
    { code: 'LA', name: 'Laos', domain_default: null },
    { code: 'LV', name: 'Latvia', domain_default: 'europe' },
    { code: 'LB', name: 'Lebanon', domain_default: 'middle_east' },
    { code: 'LS', name: 'Lesotho', domain_default: null },
    { code: 'LR', name: 'Liberia', domain_default: null },
    { code: 'LY', name: 'Libya', domain_default: null },
    { code: 'LI', name: 'Liechtenstein', domain_default: 'europe' },
    { code: 'LT', name: 'Lithuania', domain_default: 'europe' },
    { code: 'LU', name: 'Luxembourg', domain_default: 'europe' },
    { code: 'MG', name: 'Madagascar', domain_default: null },
    { code: 'MW', name: 'Malawi', domain_default: null },
    { code: 'MY', name: 'Malaysia', domain_default: null },
    { code: 'MV', name: 'Maldives', domain_default: null },
    { code: 'ML', name: 'Mali', domain_default: null },
    { code: 'MT', name: 'Malta', domain_default: 'europe' },
    { code: 'MH', name: 'Marshall Islands', domain_default: null },
    { code: 'MR', name: 'Mauritania', domain_default: null },
    { code: 'MU', name: 'Mauritius', domain_default: null },
    { code: 'MX', name: 'Mexico', domain_default: null },
    { code: 'FM', name: 'Micronesia', domain_default: null },
    { code: 'MD', name: 'Moldova', domain_default: 'europe' },
    { code: 'MC', name: 'Monaco', domain_default: 'europe' },
    { code: 'MN', name: 'Mongolia', domain_default: null },
    { code: 'ME', name: 'Montenegro', domain_default: 'europe' },
    { code: 'MA', name: 'Morocco', domain_default: null },
    { code: 'MZ', name: 'Mozambique', domain_default: null },
    { code: 'MM', name: 'Myanmar', domain_default: null },
    { code: 'NA', name: 'Namibia', domain_default: null },
    { code: 'NR', name: 'Nauru', domain_default: null },
    { code: 'NP', name: 'Nepal', domain_default: null },
    { code: 'NL', name: 'Netherlands', domain_default: 'europe' },
    { code: 'NZ', name: 'New Zealand', domain_default: null },
    { code: 'NI', name: 'Nicaragua', domain_default: null },
    { code: 'NE', name: 'Niger', domain_default: null },
    { code: 'NG', name: 'Nigeria', domain_default: null },
    { code: 'KP', name: 'North Korea', domain_default: null },
    { code: 'MK', name: 'North Macedonia', domain_default: 'europe' },
    { code: 'NO', name: 'Norway', domain_default: 'europe' },
    { code: 'OM', name: 'Oman', domain_default: 'middle_east' },
    { code: 'PK', name: 'Pakistan', domain_default: null },
    { code: 'PW', name: 'Palau', domain_default: null },
    { code: 'PS', name: 'Palestine', domain_default: 'middle_east' },
    { code: 'PA', name: 'Panama', domain_default: null },
    { code: 'PG', name: 'Papua New Guinea', domain_default: null },
    { code: 'PY', name: 'Paraguay', domain_default: null },
    { code: 'PE', name: 'Peru', domain_default: null },
    { code: 'PH', name: 'Philippines', domain_default: null },
    { code: 'PL', name: 'Poland', domain_default: 'europe' },
    { code: 'PT', name: 'Portugal', domain_default: 'europe' },
    { code: 'QA', name: 'Qatar', domain_default: 'middle_east' },
    { code: 'RO', name: 'Romania', domain_default: 'europe' },
    { code: 'RU', name: 'Russia', domain_default: null },
    { code: 'RW', name: 'Rwanda', domain_default: null },
    { code: 'KN', name: 'Saint Kitts and Nevis', domain_default: null },
    { code: 'LC', name: 'Saint Lucia', domain_default: null },
    { code: 'VC', name: 'Saint Vincent and the Grenadines', domain_default: null },
    { code: 'WS', name: 'Samoa', domain_default: null },
    { code: 'SM', name: 'San Marino', domain_default: 'europe' },
    { code: 'ST', name: 'Sao Tome and Principe', domain_default: null },
    { code: 'SA', name: 'Saudi Arabia', domain_default: 'middle_east' },
    { code: 'SN', name: 'Senegal', domain_default: null },
    { code: 'RS', name: 'Serbia', domain_default: 'europe' },
    { code: 'SC', name: 'Seychelles', domain_default: null },
    { code: 'SL', name: 'Sierra Leone', domain_default: null },
    { code: 'SG', name: 'Singapore', domain_default: null },
    { code: 'SK', name: 'Slovakia', domain_default: 'europe' },
    { code: 'SI', name: 'Slovenia', domain_default: 'europe' },
    { code: 'SB', name: 'Solomon Islands', domain_default: null },
    { code: 'SO', name: 'Somalia', domain_default: null },
    { code: 'ZA', name: 'South Africa', domain_default: null },
    { code: 'KR', name: 'South Korea', domain_default: null },
    { code: 'SS', name: 'South Sudan', domain_default: null },
    { code: 'ES', name: 'Spain', domain_default: 'europe' },
    { code: 'LK', name: 'Sri Lanka', domain_default: null },
    { code: 'SD', name: 'Sudan', domain_default: null },
    { code: 'SR', name: 'Suriname', domain_default: null },
    { code: 'SE', name: 'Sweden', domain_default: 'europe' },
    { code: 'CH', name: 'Switzerland', domain_default: 'europe' },
    { code: 'SY', name: 'Syria', domain_default: 'middle_east' },
    { code: 'TW', name: 'Taiwan', domain_default: null },
    { code: 'TJ', name: 'Tajikistan', domain_default: null },
    { code: 'TZ', name: 'Tanzania', domain_default: null },
    { code: 'TH', name: 'Thailand', domain_default: null },
    { code: 'TL', name: 'Timor-Leste', domain_default: null },
    { code: 'TG', name: 'Togo', domain_default: null },
    { code: 'TO', name: 'Tonga', domain_default: null },
    { code: 'TT', name: 'Trinidad and Tobago', domain_default: null },
    { code: 'TN', name: 'Tunisia', domain_default: null },
    { code: 'TR', name: 'Turkey', domain_default: 'middle_east' },
    { code: 'TM', name: 'Turkmenistan', domain_default: null },
    { code: 'TV', name: 'Tuvalu', domain_default: null },
    { code: 'UG', name: 'Uganda', domain_default: null },
    { code: 'UA', name: 'Ukraine', domain_default: 'europe' },
    { code: 'AE', name: 'United Arab Emirates', domain_default: 'middle_east' },
    { code: 'GB', name: 'United Kingdom', domain_default: 'europe' },
    { code: 'US', name: 'United States', domain_default: null },
    { code: 'UY', name: 'Uruguay', domain_default: null },
    { code: 'UZ', name: 'Uzbekistan', domain_default: null },
    { code: 'VU', name: 'Vanuatu', domain_default: null },
    { code: 'VA', name: 'Vatican City', domain_default: 'europe' },
    { code: 'VE', name: 'Venezuela', domain_default: null },
    { code: 'VN', name: 'Vietnam', domain_default: null },
    { code: 'YE', name: 'Yemen', domain_default: 'middle_east' },
    { code: 'ZM', name: 'Zambia', domain_default: null },
    { code: 'ZW', name: 'Zimbabwe', domain_default: null },
];

const COUNTRY_BY_CODE = Object.fromEntries(COUNTRIES.map(c => [c.code, c]));
const COUNTRY_BY_NAME = Object.fromEntries(
    COUNTRIES.map(c => [c.name.toLowerCase(), c])
);

/**
 * Look up a country by its ISO 3166-1 alpha-2 code (case-insensitive).
 */
function findByCode(code) {
    if (!code) return null;
    return COUNTRY_BY_CODE[String(code).toUpperCase()] || null;
}

/**
 * Look up a country by its English name (case-insensitive). Returns null
 * if there is no match — caller decides whether to reject or save raw.
 */
function findByName(name) {
    if (!name) return null;
    return COUNTRY_BY_NAME[String(name).trim().toLowerCase()] || null;
}

/**
 * Resolve { country, country_code, domain } from any combination of inputs.
 * Domain is only auto-filled when caller did not supply one AND the country
 * has a confident default. Returns null fields when nothing matches.
 */
function resolveCountry({ name, code, domain } = {}) {
    let match = null;
    if (code) match = findByCode(code);
    if (!match && name) match = findByName(name);

    if (!match) {
        return {
            country: name || null,
            country_code: code ? String(code).toUpperCase() : null,
            domain: domain || null,
        };
    }
    return {
        country: match.name,
        country_code: match.code,
        domain: domain || match.domain_default || null,
    };
}

module.exports = {
    COUNTRIES,
    findByCode,
    findByName,
    resolveCountry,
};
