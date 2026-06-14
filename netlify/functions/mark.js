
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }
  try {
    const { prompt } = JSON.parse(event.body);
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://fancy-biscotti-d244de.netlify.app",
        "X-Title": "BusinessGPT"
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4-5",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 8000,
        temperature: 0
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.choices?.[0]?.message?.content || "";
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    };
  } catch (err) {
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: err.message }) 
    };
  }
};
