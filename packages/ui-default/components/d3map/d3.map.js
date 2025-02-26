import * as d3 from "d3";

export default function initD3(selectedMainNodeId) {
  const width = 200;
  const height = 200;

  const svg = d3.select("#d3-test")
    .attr("viewBox", [-width / 2, -height / 2, width, height])
    .attr("preserveAspectRatio", "xMidYMid meet")
    .attr("style", "width: 100%; height: 100%;")
    .style("background-image", "url('https://picsum.photos/400/300')")
    .style("background-size", "cover")
    .style("background-position", "center");


  const nodes = JSON.parse(JSON.stringify(UiContext.nodes));
  const links = JSON.parse(JSON.stringify(UiContext.links));

  if (!selectedMainNodeId) {
    console.error("No main node ID provided for rendering.");
    return;
  }

  const filteredNodes = nodes.filter(d => {
    return (d.relatedMainId === selectedMainNodeId) && (d.type !== 'main');
  });

  const filteredLinks = links.filter(d => {
    return filteredNodes.some(node => node.id === d.source) &&
           filteredNodes.some(node => node.id === d.target);
  });

  svg.selectAll("*").remove();

  const simulation = d3.forceSimulation(filteredNodes)
    .force("link", d3.forceLink(filteredLinks).id(d => d.id).distance(30))
    .force("charge", d3.forceManyBody()
      .strength(d => d.type === 'file' ? -30 : -10))
    .force("center", d3.forceCenter(0, 0))
    .force("radial", d3.forceRadial(80, 0, 0))
    .on("tick", ticked);

  const link = svg.append("g")
    .attr("stroke", "#999")
    .attr("stroke-opacity", 0.6)
    .selectAll("line")
    .data(filteredLinks)
    .enter()
    .append("line");

  const node = svg.append("g")
    .attr("stroke", "#fff")
    .attr("stroke-width", 1.5)
    .selectAll("circle")
    .data(filteredNodes)
    .enter()
    .append("circle")
    .attr("r", d => {
      if (d.type === 'sub') return 4;
      return 3;
    })
    .attr("fill", d => {
      if (d.type === 'sub') return "green";
      return "orange";
    })
    .on("mouseover", (event, d) => {
      d3.select("#info-display").text(
        `Node ${d.id}: \nContent: ${d.content}\nX: ${d.x}, Y: ${d.y}`
      );
    })
    .on("mouseout", () => {
      d3.select("#info-display").text("");
    })
    .on("click", (event, d) => {
      const targetElement = document.getElementById(`comment-${d.id}`);
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: "smooth" });
      }
    })
    .call(d3.drag()
      .on("start", (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      })
    );

  function ticked() {
    link
      .attr("x1", d => d.source.x)
      .attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x)
      .attr("y2", d => d.target.y);

    node
      .attr("cx", d => d.x)
      .attr("cy", d => d.y);
  }
}