package com.droidbridge.standalone.product.release

/** The shapes of the failure code and stage the update flow reports, shared by every layer that stores or shows them. */
internal fun validUpdateCode(value: String): Boolean = value.matches(Regex("[A-Z][A-Z0-9_]{0,63}"))

internal fun validUpdateStage(value: String): Boolean = value.matches(Regex("[a-z][a-z0-9_]{0,47}"))
