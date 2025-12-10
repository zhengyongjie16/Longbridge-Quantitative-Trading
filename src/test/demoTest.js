import  {Config, QuoteContext} from "longport"

let config = Config.fromEnv()
QuoteContext.new(config)
  .then((ctx) => ctx.warrantQuote(["54806.HK"]))
  .then((resp) => {
    for (let obj of resp) {
      console.log(obj.toString())
    }
  })