import metadata from '../metadata.min.json'
import fs from 'fs'

const countryCodes = Object.keys(metadata.countries)

fs.writeFileSync(
	'./types.d.ts',
	fs.readFileSync('./types.d.ts', 'utf-8').replace(
		/export type CountryCode = .*;\\n/,
		`export type CountryCode = ${countryCodes.join(' | ')};\n`
	),
	'utf-8'
)