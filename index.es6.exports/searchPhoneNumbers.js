import withMetadataArgument from '../min/exports/withMetadataArgument.js'

import { searchPhoneNumbers as _searchPhoneNumbers } from '../es6/findPhoneNumbers.js'

export function searchPhoneNumbers() {
	return withMetadataArgument(_searchPhoneNumbers, arguments)
}
