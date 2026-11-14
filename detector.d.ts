/** Generated ELD medium model, restricted to English and German. */
export const detector: {
  detect(text: string): {
    language: string
    getScores(): Record<string, number>
    isReliable(): boolean
  }
}
