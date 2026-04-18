const parser = {
  parse() {
    throw new Error('curl string parsing is disabled; runtimeWorker passes tokenized argv to curlconverter')
  },
}

export default parser
