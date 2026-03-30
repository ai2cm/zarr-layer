export const sectionHeadingSx = {
  fontFamily: 'mono',
  letterSpacing: 'smallcaps',
  textTransform: 'uppercase' as const,
  fontSize: [2, 2, 2, 3],
}

export const subheadingSx = {
  ...sectionHeadingSx,
  my: [2, 2, 2, 3],
  fontSize: [1, 1, 1, 2],
  color: 'secondary',
}
